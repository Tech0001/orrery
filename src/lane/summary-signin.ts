/** Summary sign-in shared by the CLI, TUI and pi/OMP extensions. */

import type { AuthInteraction } from "@earendil-works/pi-ai";
import { credentialOrigin, type OrreryCredential } from "./credentials.ts";
import { ensureDeviceId } from "./models.ts";
import { openrouterSignIn, type OpenRouterSignInOptions } from "./openrouter-signin.ts";
import { providerFor, type SummarySources } from "./summary-sources.ts";

/** The ChatGPT sign-in; `interaction` shows the link and asks what the flow asks. */
export async function signIn(sources: SummarySources, interaction: AuthInteraction, name = "openai", options: OpenRouterSignInOptions = {}): Promise<void> {
	providerFor(sources.config, "signin", name);
	if (name === "openrouter") {
		const key = await openrouterSignIn(interaction, options);
		let replaced = false;
		await sources.credentials.modify("openrouter", async (current) => {
			replaced = current !== undefined && credentialOrigin(current) !== "signin";
			return { type: "api_key", key, origin: "signin" } as OrreryCredential;
		}, interaction.signal === undefined ? undefined : { signal: interaction.signal });
		if (replaced) interaction.notify({ type: "info", message: "Replaced the pasted OpenRouter key with the key from sign-in." });
		return;
	}
	await sources.models.login("openai", "oauth", interaction, { getDeviceId: () => ensureDeviceId(sources.config.deviceIdPath) });
}

