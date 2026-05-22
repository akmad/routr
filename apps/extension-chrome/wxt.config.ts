import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'wxt';

// Single source for both Chrome (MV3, service worker) and Firefox (MV3,
// event page). WXT handles the manifest translation. `extensionApi: 'chrome'`
// polyfills `browser.*` via webextension-polyfill so the same source works
// on both. Run `wxt build --browser firefox --mv3` (or `pnpm build:firefox`)
// to produce a Firefox-targeted bundle in `.output/firefox-mv3/`.
export default defineConfig({
  extensionApi: 'chrome',
  srcDir: 'src',
  // The Firefox build emits a warning about `data_collection_permissions` —
  // a Mozilla policy change effective Nov 2025 for *new* extensions. Beam
  // is end-to-end encrypted and the extension never sends any data to a
  // third party; the only network traffic is to the user's own Beam
  // server. Suppressing the warning is honest here.
  // biome-ignore lint/suspicious/noExplicitAny: WXT config types lag the actual schema
  suppressWarnings: { firefoxDataCollection: true } as any,
  manifest: {
    name: 'Beam',
    description: 'Share URLs and files to your devices — end-to-end encrypted.',
    permissions: ['storage', 'contextMenus', 'notifications'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Beam',
      default_popup: 'popup.html',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    commands: {
      'send-current-tab': {
        suggested_key: {
          default: 'Ctrl+Shift+B',
          mac: 'Command+Shift+B',
        },
        description: 'Send the current tab with Beam',
      },
    },
    // Firefox needs this for AMO signing and stable storage namespaces.
    // Chrome ignores unknown manifest keys. The id is a placeholder for
    // self-hosters; for distribution on addons.mozilla.org, replace with
    // a project-owned identifier.
    browser_specific_settings: {
      gecko: {
        id: 'beam@routr.local',
        strict_min_version: '109.0',
      },
    },
  },
  vite: () => ({
    plugins: [react(), tailwindcss()],
  }),
});
