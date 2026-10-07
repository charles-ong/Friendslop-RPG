import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { registerServiceWorker } from './lib/alerts';

registerServiceWorker();

export default mount(App, { target: document.getElementById('app')! });
