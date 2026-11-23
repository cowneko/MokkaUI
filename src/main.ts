import "./app.css";
// Runs on import, before any store initialisation touches localStorage.
import { legacyKeysMigrated } from "./lib/utils/legacyStorageBoot.js";
import { installConsoleInterceptor } from "./lib/utils/log-buffer.js";
import { installExternalLinkHandler } from "./lib/utils/openExternal.js";
import App from "./App.svelte";
import { mount } from "svelte";

// Install before mounting so startup logs are captured.
installConsoleInterceptor();
if (legacyKeysMigrated > 0) {
  console.log(`[startup] copied ${legacyKeysMigrated} setting(s) from their pre-rename storage keys`);
}
installExternalLinkHandler();

const app = mount(App, { target: document.getElementById("app")! });

export default app;
