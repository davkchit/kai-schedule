import { useLayoutEffect, useState } from 'react';

export default function usePageAssets({ title, description, stylesheets = [], links = [] }) {
    const [isReady, setIsReady] = useState(stylesheets.length === 0);
    // Pages pass these as inline array literals, a new array every render.
    // Keyed by content instead, the effect re-runs only when the assets
    // actually change — not on every render of the page.
    const stylesheetsKey = stylesheets.join('|');
    const linksKey = JSON.stringify(links);

    useLayoutEffect(() => {
        const previousTitle = document.title;
        document.title = title;
        setIsReady(stylesheets.length === 0);

        let metaDescription = document.querySelector('meta[name="description"]');
        const hadMetaDescription = Boolean(metaDescription);
        const previousDescription = metaDescription?.getAttribute('content') ?? '';

        if (!metaDescription) {
            metaDescription = document.createElement('meta');
            metaDescription.name = 'description';
            document.head.appendChild(metaDescription);
        }

        metaDescription.setAttribute('content', description);

        const addedNodes = [];
        const stylesheetPromises = [];

        for (const href of stylesheets) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            // The build's version (vite.config.js) lets the service worker
            // serve a saved copy at once; absent in a plain dev run.
            link.href = typeof __BUILD_ID__ !== 'undefined' ? `${href}?v=${__BUILD_ID__}` : href;
            stylesheetPromises.push(new Promise((resolve) => {
                link.addEventListener('load', resolve, { once: true });
                link.addEventListener('error', resolve, { once: true });
            }));

            document.head.appendChild(link);
            addedNodes.push(link);
        }

        for (const attributes of links) {
            const link = document.createElement('link');

            for (const [key, value] of Object.entries(attributes)) {
                link.setAttribute(key, value);
            }

            document.head.appendChild(link);
            addedNodes.push(link);
        }

        let ignore = false;

        if (stylesheetPromises.length === 0) {
            setIsReady(true);
        } else {
            Promise.all(stylesheetPromises).then(() => {
                if (!ignore) {
                    setIsReady(true);
                }
            });
        }

        return () => {
            ignore = true;
            document.title = previousTitle;

            if (hadMetaDescription) {
                metaDescription.setAttribute('content', previousDescription);
            } else {
                metaDescription.remove();
            }

            for (const node of addedNodes) {
                node.remove();
            }
        };
        // stylesheets/links are represented by their content keys (see above).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [title, description, stylesheetsKey, linksKey]);

    return isReady;
}
