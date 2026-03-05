Add native Zotero 7/8 API mode — Better BibTeX no longer required

- New "Use native Zotero API (Zotero 7/8)" toggle in settings. When enabled, the plugin queries the standard Zotero local REST API (http://localhost:23119/api/) directly using the citationKey field that Zotero 7 and 8 expose natively. Better BibTeX does not need to be installed.
- Version-based incremental sync (Zotero library version) replaces timestamp-based refresh when native mode is active.
- "Open in Zotero" and PDF attachment links work in native mode via the standard items API.
- Better BibTeX mode is unchanged; the new toggle defaults to off for backwards compatibility.
