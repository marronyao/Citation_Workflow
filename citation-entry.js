import { Cite, plugins } from '@citation-js/core';
import '@citation-js/plugin-csl';
import '@citation-js/plugin-bibtex';
import styles from './vendor/csl/styles.json';
for (const [name, style] of Object.entries(styles)) {
  plugins.config.get('@csl').styles.add(name, style);
}
window.Cite = Cite;
