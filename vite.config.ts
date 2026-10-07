import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Relative base so the build works at any GitHub Pages path.
export default defineConfig({
  base: './',
  plugins: [svelte()],
});
