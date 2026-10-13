.PHONY: test check demo

test:
	uv run python -m unittest discover -s tests -v

check:
	uv run ruff check optchat tests
	uv run ruff format --check optchat tests

demo:
	uv run optchat demo
