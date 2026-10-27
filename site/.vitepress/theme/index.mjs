// The default VitePress theme with the site's own fonts and colours, and the front page's Landing component.
import DefaultTheme from 'vitepress/theme-without-fonts';
import Landing from './Landing.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({app}) {
    app.component('Landing', Landing);
  },
};
