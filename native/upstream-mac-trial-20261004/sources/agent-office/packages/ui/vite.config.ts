import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), 'AGENT_OFFICE_');
    const port = Number(env.AGENT_OFFICE_UI_PORT || 5189);
    const serverUrl = env.AGENT_OFFICE_SERVER_URL || 'http://127.0.0.1:3029';
    return {
        plugins: [react()],
        server: {
            host: '127.0.0.1',
            port,
            strictPort: true,
            proxy: {
                '/api': serverUrl,
            }
        },
        build: {
            outDir: 'dist'
        }
    };
});
