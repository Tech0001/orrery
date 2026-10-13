/** The dependency-free SSH storage protocol: opaque binary files, fenced writes, and server-clock locks. */

// Keep this POSIX sh; payload bytes arrive on stdin, separately from this quoted command.
export const SERVER_SCRIPT = `set -eu
umask 077
export LC_ALL=C
op=$1
folder=$2
lane=$3
shift 3
case "$folder" in "~/"*) folder=$HOME/\${folder#??} ;; /*) ;; *) folder=./$folder ;; esac
mkdir -p "$folder"
request=
mutex=
claim=
claim_stage=
# $0 contains a fresh client UUID, so a retired claim path is never reused.
token=$0.$$
case "$token" in *[!A-Za-z0-9._-]*) exit 1 ;; esac

cleanup() {
	if [ -n "$claim" ]; then rm -rf "$claim"; fi
	if [ -n "$claim_stage" ]; then rm -rf "$claim_stage"; fi
	if [ -n "$request" ]; then rm -rf "$request"; fi
}
trap cleanup 0
trap 'exit 1' 1 2 15
refused() { printf '%s\\n' "$1" >&2; exit 1; }
missing() { printf 'missing\\n'; exit 5; }
lost() { printf 'lost\\n'; exit 3; }
order() { printf 'order\\t%s\\n' "$newest"; exit 4; }
number() {
	case "$1" in ''|*[!0-9]*) refused 'Invalid number' ;; esac
	[ "\${#1}" -le 15 ] || refused 'Number is too large'
}
valid_lane() {
	case "$1" in ''|[!A-Za-z]*|*[!A-Za-z0-9_-]*) return 1 ;; esac
	[ "\${#1}" -le 32 ]
}
# A bakery mutex: each operation publishes a unique claim, then takes a ticket.
# Algorithm: https://lamport.azurewebsites.net/pubs/bakery.pdf
# Readers wait for choosing contenders and for lower (ticket, pid) pairs. Only
# unique claim paths are ever removed: recovery cannot unlink a successor's lock.
acquire() {
	mutex=$1/.mutex
	mkdir -p "$mutex"
	claim=$mutex/claim-$token
	claim_stage=$1/.claim-$token
	mkdir "$claim_stage"
	printf '%s %s\\n' "$$" "$(date +%s)" > "$claim_stage/owner"
	# Publish owner and choosing state together; a crash before this move cannot block anyone.
	mv "$claim_stage" "$claim"
	claim_stage=
	ticket=1
	for other in "$mutex"/claim-*/ticket; do
		other_ticket=0
		if read -r other_ticket 2>/dev/null < "$other"; then
			if [ "$other_ticket" -ge "$ticket" ]; then ticket=$((other_ticket + 1)); fi
		fi
	done
	printf '%s\\n' "$ticket" > "$claim/.ticket.tmp"
	mv "$claim/.ticket.tmp" "$claim/ticket"
	attempt=0
	while :; do
		blocked=0
		for other in "$mutex"/claim-*; do
			[ "$other" != "$claim" ] && [ -d "$other" ] || continue
			owner_pid=0; owner_at=0
			if ! read -r owner_pid owner_at 2>/dev/null < "$other/owner"; then continue; fi
			# A dead process cannot return. This particular claim name will never be reused,
			# even if a later process gets the same PID. There is no separate reaper to orphan.
			if [ "$(($(date +%s) - owner_at))" -gt 30 ] && ! kill -0 "$owner_pid" 2>/dev/null; then
				rm -rf "$other"
				continue
			fi
			other_ticket=0
			if ! read -r other_ticket 2>/dev/null < "$other/ticket"; then
				# A published owner without a ticket is still choosing its place.
				if [ -d "$other" ]; then blocked=1; break; fi
			elif [ "$other_ticket" -lt "$ticket" ] || { [ "$other_ticket" -eq "$ticket" ] && [ "$owner_pid" -lt "$$" ]; }; then
				blocked=1; break
			fi
		done
		[ "$blocked" = 1 ] || return 0
		attempt=$((attempt + 1))
		[ "$attempt" -lt 100 ] || refused 'Remote is busy; retry the operation'
		sleep 0.05
	done
}
unlock() { rm -rf "$claim"; claim=; }
read_lock() {
	lock=0; held=0; seen=0; machine=; device=; pid=0; newest=0; stale=0
	if [ -f "$base/newest" ]; then read -r newest < "$base/newest"; fi
	if [ -f "$base/lock" ]; then
		read -r lock held seen machine device pid < "$base/lock"
	fi
	now=$(date +%s)
	stale_seconds=\${ORRERY_TEST_STALE_SECONDS:-180}
	number "$stale_seconds"
	if [ "$held" = 1 ] && [ "$((now - seen))" -gt "$stale_seconds" ]; then stale=1; fi
}
write_lock() {
	printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$lock" "$held" "$seen" "$machine" "$device" "$pid" > "$base/.lock.tmp.$$"
	mv "$base/.lock.tmp.$$" "$base/lock"
}
check_lock() { [ "$held" = 1 ] && [ "$lock" = "$1" ] || lost; }
lock_fields() { printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s' "$lock" "$held" "$seen" "$machine" "$device" "$pid" "$stale"; }
size() { wc -c < "$1"; }
frame() {
	printf 'file\\t%s\\t%s\\t%s\\n' "$1" "$2" "$(size "$3")"
	cat "$3"
}
# Migrate the old key-check filename before a lane called check needs that name.
if [ -f "$folder/check" ]; then
	acquire "$folder"
	if [ ! -f "$folder/.orrery-check" ] && [ -f "$folder/check" ]; then
		mv "$folder/check" "$folder/.orrery-check"
	fi
	unlock
fi
# Stage binary stdin BEFORE taking the mutex. Only publication holds it.
case "$op" in
	save|snapshot|putCheck)
		request=$folder/.request.$token
		mkdir "$request"
		case "$op" in
			save)
				file_bytes=$3; log_bytes=$4
				number "$file_bytes"; number "$log_bytes"
				dd bs=1 count="$log_bytes" of="$request/log" 2>/dev/null
				[ "$(size "$request/log")" -eq "$log_bytes" ] || refused 'Incomplete log upload'
				;;
			snapshot) file_bytes=$3 ;;
			putCheck) file_bytes=$1 ;;
		esac
		number "$file_bytes"
		cat > "$request/file"
		[ "$(size "$request/file")" -eq "$file_bytes" ] || refused 'Incomplete file upload'
		;;
esac
case "$op" in
	getCheck|putCheck)
		acquire "$folder"
		if [ "$op" = putCheck ]; then
			if [ -f "$folder/.orrery-check" ]; then
				cmp -s "$folder/.orrery-check" "$request/file" || refused 'The remote already has a different key check'
			else
				mv "$request/file" "$folder/.orrery-check"
			fi
			printf 'ok\\n'
		elif [ -f "$folder/.orrery-check" ]; then
			printf 'ok\\t%s\\n' "$(size "$folder/.orrery-check")"
			cat "$folder/.orrery-check"
		else
			printf 'none\\n'
		fi
		exit
		;;
	list)
		for base in "$folder"/*; do
			[ -d "$base" ] || continue
			name=\${base##*/}
			valid_lane "$name" || continue
			acquire "$base"
			if [ -f "$base/lock" ]; then
				read_lock
				printf 'lane\\t%s\\t%s\\t' "$name" "$newest"
				lock_fields
				printf '\\n'
			fi
			unlock
		done
		printf 'ok\\n'
		exit
		;;
esac
valid_lane "$lane" || refused 'Invalid lane name'
base=$folder/$lane
acquire "$base"
read_lock
case "$op" in
	take)
		if [ "$held" = 1 ]; then
			if [ "$4" != 1 ] || { [ "$stale" != 1 ] && [ "$device" != "$2" ]; }; then
				printf 'held\\t'; lock_fields; printf '\\n'; exit
			fi
		fi
		# Keep the fencing counter even after drop, so an old request can never match a recreated lane.
		if [ -f "$base/.counter" ]; then read -r lock < "$base/.counter"; fi
		lock=$((lock + 1)); held=1; seen=$now; machine=$1; device=$2; pid=$3
		printf '%s\\n' "$lock" > "$base/.counter.tmp.$$"
		mv "$base/.counter.tmp.$$" "$base/.counter"
		mkdir -p "$base/saves" "$base/logs" "$base/snapshots"
		write_lock
		printf 'ok\\t%s\\t%s\\n' "$lock" "$newest"
		;;
	renew)
		check_lock "$1"
		seen=$now; write_lock
		printf 'ok\\n'
		;;
	release)
		if [ "$held" = 1 ] && [ "$lock" = "$1" ]; then held=0; write_lock; fi
		printf 'ok\\n'
		;;
	save)
		check_lock "$1"
		n=$2; number "$n"
		if [ "$n" -eq "$newest" ] && [ "$n" -gt 0 ]; then
			cmp -s "$request/file" "$base/saves/$n" && cmp -s "$request/log" "$base/logs/$n" || order
		elif [ "$n" -eq "$((newest + 1))" ]; then
			mv "$request/log" "$base/logs/$n"
			mv "$request/file" "$base/saves/$n"
			# Readers use newest as the commit point. An interrupted save can safely overwrite uncommitted files.
			printf '%s\\n' "$n" > "$base/.newest.tmp.$$"
			mv "$base/.newest.tmp.$$" "$base/newest"
			seen=$now; write_lock
		else
			order
		fi
		printf 'ok\\n'
		;;
	snapshot)
		check_lock "$1"
		n=$2; number "$n"
		[ "$n" -le "$newest" ] || order
		mv "$request/file" "$base/snapshots/$n"
		first=-1; second=-1; third=-1
		for path in "$base/snapshots"/*; do
			[ -f "$path" ] || continue
			value=\${path##*/}; number "$value"
			if [ "$value" -gt "$first" ]; then third=$second; second=$first; first=$value
			elif [ "$value" -gt "$second" ]; then third=$second; second=$value
			elif [ "$value" -gt "$third" ]; then third=$value; fi
		done
		oldest=$first
		if [ "$second" -ge 0 ]; then oldest=$second; fi
		if [ "$third" -ge 0 ]; then oldest=$third; fi
		for path in "$base/snapshots"/*; do
			[ -f "$path" ] || continue
			value=\${path##*/}
			if [ "$value" -lt "$oldest" ]; then rm -f "$path"; fi
		done
		for path in "$base/saves"/*; do
			[ -f "$path" ] || continue
			value=\${path##*/}; number "$value"
			# The newest save remains available for an identical retry after a lost reply.
			if [ "$value" -le "$oldest" ] && [ "$value" -ne "$newest" ]; then rm -f "$path"; fi
		done
		seen=$now; write_lock
		printf 'ok\\n'
		;;
	fetch)
		[ -f "$base/lock" ] || missing
		after=$1
		if [ "$after" != -1 ]; then number "$after"; fi
		snapshot=-1
		for path in "$base/snapshots"/*; do
			[ -f "$path" ] || continue
			value=\${path##*/}; number "$value"
			if [ "$value" -gt "$snapshot" ]; then snapshot=$value; fi
		done
		# Pin the committed inodes under the mutex. Publication uses rename, never
		# edits these files, so replacement, pruning and drop cannot change this reply.
		request=$folder/.request.$token
		mkdir "$request"
		total=0
		if [ "$snapshot" -gt "$after" ]; then
			ln "$base/snapshots/$snapshot" "$request/snapshot"
			after=$snapshot
			total=$(size "$base/snapshots/$snapshot")
		else
			snapshot=-1
		fi
		start=$((after + 1)); [ "$start" -gt 0 ] || start=1
		n=$start
		while [ "$n" -le "$newest" ]; do
			ln "$base/saves/$n" "$request/$n"
			total=$((total + $(size "$request/$n"))); n=$((n + 1))
		done
		# Release before writing even the header: a slow reader must never block saves.
		unlock
		printf 'ok\\t%s\\t%s\\n' "$newest" "$total"
		if [ "$snapshot" -ge 0 ]; then frame snapshot "$snapshot" "$request/snapshot"; fi
		n=$start
		while [ "$n" -le "$newest" ]; do frame save "$n" "$request/$n"; n=$((n + 1)); done
		;;
	log)
		[ -f "$base/lock" ] || missing
		total=0; n=1
		while [ "$n" -le "$newest" ]; do total=$((total + $(size "$base/logs/$n"))); n=$((n + 1)); done
		printf 'ok\\t%s\\n' "$total"
		n=1
		while [ "$n" -le "$newest" ]; do frame log "$n" "$base/logs/$n"; n=$((n + 1)); done
		;;
	drop)
		check_lock "$1"
		rm -rf "$base/lock" "$base/newest" "$base/saves" "$base/logs" "$base/snapshots"
		printf 'ok\\n'
		;;
	*) refused 'Unknown remote operation' ;;
esac
`;
