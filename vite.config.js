import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The stylesheets in client-public keep their names across releases; each
// build asks for them with its own version, so the service worker can serve a
// saved copy at once without ever pairing new code with old styles.
const BUILD_ID = Date.now().toString(36);

const versionStylesheets = {
    name: 'version-stylesheets',
    transformIndexHtml: (html) => html.replace(/(\/css\/[\w-]+\.css)/g, `$1?v=${BUILD_ID}`)
};

export default defineConfig({
    plugins: [react(), versionStylesheets],
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    publicDir: 'client-public',
    server: {
        host: '127.0.0.1',
        port: 5173,
        allowedHosts: true,
        proxy: {
            '/api': 'http://localhost:3000'
        }
    }
});
