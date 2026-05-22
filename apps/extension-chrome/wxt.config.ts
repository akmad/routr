import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'wxt';

export default defineConfig({
  extensionApi: 'chrome',
  srcDir: 'src',
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
  },
  vite: () => ({
    plugins: [react(), tailwindcss()],
  }),
});
