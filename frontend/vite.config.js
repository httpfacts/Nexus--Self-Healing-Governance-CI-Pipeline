import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api": "http://localhost:4000",
      // OAuth login must round-trip through the same origin the browser
      // calls /api from, otherwise the session cookie GitHub's callback
      // sets on :4000 never reaches fetches made from :3000.
      "/auth": "http://localhost:4000",
    },
  },
});
