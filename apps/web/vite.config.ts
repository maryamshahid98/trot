import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API allows http://localhost:5173 (CORS_ORIGINS in .env), so the app calls it directly.
export default defineConfig({ plugins: [react()], server: { port: 5173, strictPort: true } });
