// Entry for the chat in Chrome's side panel (src/sidepanel.html, PR 11.8).
// See sidePanelPage.ts.
import './sidePanel.css';
import { createSidePanelPage } from './sidePanelPage';

createSidePanelPage(document, chrome.tabs);
