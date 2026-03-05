import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import https from 'https';
import download from 'download';
import { request } from 'http';
import { CSLList, PartialCSLEntry } from './types';

export const DEFAULT_ZOTERO_PORT = '23119';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getBibPath(bibPath: string, getVaultRoot?: () => string) {
  if (!fs.existsSync(bibPath)) {
    const orig = bibPath;
    if (getVaultRoot) {
      bibPath = path.join(getVaultRoot(), bibPath);
      if (!fs.existsSync(bibPath)) {
        throw new Error(`bibToCSL: cannot access bibliography file '${bibPath}'.`);
      }
    } else {
      throw new Error(`bibToCSL: cannot access bibliography file '${orig}'.`);
    }
  }

  return bibPath;
}

export async function bibToCSL(
  bibPath: string,
  pathToPandoc: string,
  getVaultRoot?: () => string
): Promise<PartialCSLEntry[]> {
  bibPath = getBibPath(bibPath, getVaultRoot);

  const parsed = path.parse(bibPath);
  if (parsed.ext === '.json') {
    return new Promise((res, rej) => {
      fs.readFile(bibPath, (err, data) => {
        if (err) return rej(err);
        try {
          res(JSON.parse(data.toString()));
        } catch (e) {
          rej(e);
        }
      });
    });
  }

  if (!pathToPandoc) {
    throw new Error('bibToCSL: path to pandoc is required for non CSL files.');
  }

  if (!fs.existsSync(pathToPandoc)) {
    throw new Error(`bibToCSL: cannot access pandoc at '${pathToPandoc}'.`);
  }

  const args = [bibPath, '-t', 'csljson', '--quiet'];

  const res = await execa(pathToPandoc, args);

  if (res.stderr) {
    throw new Error(`bibToCSL: ${res.stderr}`);
  }

  return JSON.parse(res.stdout);
}

export async function getCSLLocale(
  localeCache: Map<string, string>,
  cacheDir: string,
  lang: string
) {
  if (localeCache.has(lang)) {
    return localeCache.get(lang);
  }

  const url = `https://raw.githubusercontent.com/citation-style-language/locales/master/locales-${lang}.xml`;
  const outpath = path.join(cacheDir, `locales-${lang}.xml`);

  ensureDir(cacheDir);
  if (fs.existsSync(outpath)) {
    const localeData = fs.readFileSync(outpath).toString();
    localeCache.set(lang, localeData);
    return localeData;
  }

  const str = await new Promise<string>((res, rej) => {
    https.get(url, (result) => {
      let output = '';

      result.setEncoding('utf8');
      result.on('data', (chunk) => (output += chunk));
      result.on('error', (e) => rej(`Downloading locale: ${e}`));
      result.on('close', () => {
        rej(new Error('Error: cannot download locale'));
      });
      result.on('end', () => {
        if (/^404: Not Found/.test(output)) {
          rej(new Error('Error downloading locale: 404: Not Found'));
        } else {
          res(output);
        }
      });
    });
  });

  fs.writeFileSync(outpath, str);
  localeCache.set(lang, str);
  return str;
}

export async function getCSLStyle(
  styleCache: Map<string, string>,
  cacheDir: string,
  url: string,
  explicitPath?: string
) {
  if (explicitPath) {
    if (styleCache.has(explicitPath)) {
      return styleCache.get(explicitPath);
    }

    if (!fs.existsSync(explicitPath)) {
      throw new Error(
        `Error: retrieving citation style; Cannot find file '${explicitPath}'.`
      );
    }

    const styleData = fs.readFileSync(explicitPath).toString();
    styleCache.set(explicitPath, styleData);
    return styleData;
  }

  if (styleCache.has(url)) {
    return styleCache.get(url);
  }

  const fileFromURL = url.split('/').pop();
  const outpath = path.join(cacheDir, fileFromURL);

  ensureDir(cacheDir);
  if (fs.existsSync(outpath)) {
    const styleData = fs.readFileSync(outpath).toString();
    styleCache.set(url, styleData);
    return styleData;
  }

  const str = await new Promise<string>((res, rej) => {
    https.get(url, (result) => {
      let output = '';

      result.setEncoding('utf8');
      result.on('data', (chunk) => (output += chunk));
      result.on('error', (e) => rej(`Error downloading CSL: ${e}`));
      result.on('close', () => {
        rej(new Error('Error: cannot download CSL'));
      });
      result.on('end', () => {
        try {
          res(output);
        } catch (e) {
          rej(e);
        }
      });
    });
  });

  fs.writeFileSync(outpath, str);
  styleCache.set(url, str);
  return str;
}

export const defaultHeaders = {
  'Content-Type': 'application/json',
  'User-Agent': 'obsidian/zotero',
  Accept: 'application/json',
  Connection: 'keep-alive',
};

function getGlobal() {
  if (window?.activeWindow) return activeWindow;
  if (window) return window;
  return global;
}

export async function getZUserGroups(
  port: string = DEFAULT_ZOTERO_PORT
): Promise<Array<{ id: number; name: string }>> {
  if (!(await isZoteroRunning(port))) return null;

  return new Promise((res, rej) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'user.groups',
    });

    const postRequest = request(
      {
        host: '127.0.0.1',
        port: port,
        path: '/better-bibtex/json-rpc',
        method: 'POST',
        headers: {
          ...defaultHeaders,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (result) => {
        let output = '';

        result.setEncoding('utf8');
        result.on('data', (chunk) => (output += chunk));
        result.on('error', (e) => rej(`Error connecting to Zotero: ${e}`));
        result.on('close', () => {
          rej(new Error('Error: cannot connect to Zotero'));
        });
        result.on('end', () => {
          try {
            res(JSON.parse(output).result);
          } catch (e) {
            rej(e);
          }
        });
      }
    );

    postRequest.write(body);
    postRequest.end();
  });
}

function panNum(n: number) {
  if (n < 10) return `0${n}`;
  return n.toString();
}

function timestampToZDate(ts: number) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${panNum(d.getUTCMonth() + 1)}-${panNum(
    d.getUTCDate()
  )} ${panNum(d.getUTCHours())}:${panNum(d.getUTCMinutes())}:${panNum(
    d.getUTCSeconds()
  )}`;
}

export async function getZModified(
  port: string = DEFAULT_ZOTERO_PORT,
  groupId: number,
  since: number
): Promise<CSLList> {
  if (!(await isZoteroRunning(port))) return null;

  return new Promise((res, rej) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'item.search',
      params: [[['dateModified', 'isAfter', timestampToZDate(since)]], groupId],
    });

    const postRequest = request(
      {
        host: '127.0.0.1',
        port: port,
        path: '/better-bibtex/json-rpc',
        method: 'POST',
        headers: {
          ...defaultHeaders,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (result) => {
        let output = '';

        result.setEncoding('utf8');
        result.on('data', (chunk) => (output += chunk));
        result.on('error', (e) => rej(`Error connecting to Zotero: ${e}`));
        result.on('close', () => {
          rej(new Error('Error: cannot connect to Zotero'));
        });
        result.on('end', () => {
          try {
            res(JSON.parse(output).result);
          } catch (e) {
            rej(e);
          }
        });
      }
    );

    postRequest.write(body);
    postRequest.end();
  });
}

function applyGroupID(list: CSLList, groupId: number) {
  return list.map((item) => {
    item.groupID = groupId;
    return item;
  });
}

export async function getZBib(
  port: string = DEFAULT_ZOTERO_PORT,
  cacheDir: string,
  groupId: number,
  loadCached?: boolean
) {
  const isRunning = await isZoteroRunning(port);
  const cached = path.join(cacheDir, `zotero-library-${groupId}.json`);

  ensureDir(cacheDir);
  if (loadCached || !isRunning) {
    if (fs.existsSync(cached)) {
      return applyGroupID(
        JSON.parse(fs.readFileSync(cached).toString()) as CSLList,
        groupId
      );
    }
    if (!isRunning) {
      return null;
    }
  }

  const bib = await download(
    `http://127.0.0.1:${port}/better-bibtex/export/library?/${groupId}/library.json`
  );

  const str = bib.toString();

  fs.writeFileSync(cached, str);

  return applyGroupID(JSON.parse(str) as CSLList, groupId);
}

export async function refreshZBib(
  port: string = DEFAULT_ZOTERO_PORT,
  cacheDir: string,
  groupId: number,
  since: number
) {
  if (!(await isZoteroRunning(port))) {
    return null;
  }

  const cached = path.join(cacheDir, `zotero-library-${groupId}.json`);
  ensureDir(cacheDir);
  if (!fs.existsSync(cached)) {
    return null;
  }

  const mList = (await getZModified(port, groupId, since)) as CSLList;

  if (!mList?.length) {
    return null;
  }

  const modified: Map<string, PartialCSLEntry> = new Map();
  const newKeys: Set<string> = new Set();

  for (const mod of mList) {
    mod.id = (mod as any).citekey || (mod as any)['citation-key'];
    if (!mod.id) continue;
    modified.set(mod.id, mod);
    newKeys.add(mod.id);
  }

  const list = JSON.parse(fs.readFileSync(cached).toString()) as CSLList;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (modified.has(item.id)) {
      newKeys.delete(item.id);
      list[i] = modified.get(item.id);
    }
  }

  for (const key of newKeys) {
    list.push(modified.get(key));
  }

  fs.writeFileSync(cached, JSON.stringify(list));

  return {
    list: applyGroupID(list, groupId),
    modified,
  };
}

export async function isZoteroRunning(port: string = DEFAULT_ZOTERO_PORT) {
  const p = download(`http://127.0.0.1:${port}/better-bibtex/cayw?probe=true`);
  const res = await Promise.race([
    p,
    new Promise((res) => {
      getGlobal().setTimeout(() => {
        res(null);
        p.destroy();
      }, 150);
    }),
  ]);

  return res?.toString() === 'ready';
}

// ─── Native Zotero API (Zotero 7/8, no Better BibTeX required) ───────────────

/**
 * Low-level GET helper for the Zotero local REST API.
 * Returns parsed JSON body and the Last-Modified-Version header value.
 */
function zoteroNativeGet(
  port: string,
  apiPath: string
): Promise<{ data: any; version: number }> {
  return new Promise((res, rej) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: port,
        path: apiPath,
        method: 'GET',
        headers: { ...defaultHeaders },
      },
      (result) => {
        let output = '';
        const version = Number(result.headers['last-modified-version'] || 0);

        result.setEncoding('utf8');
        result.on('data', (chunk) => (output += chunk));
        result.on('error', (e) => rej(`Error connecting to Zotero: ${e}`));
        result.on('close', () =>
          rej(new Error('Error: cannot connect to Zotero'))
        );
        result.on('end', () => {
          try {
            res({ data: JSON.parse(output), version });
          } catch (e) {
            rej(e);
          }
        });
      }
    );
    req.end();
  });
}

/** Fetch every item from a library, paging 100 at a time. */
async function fetchAllZoteroItemsNative(
  port: string,
  libraryType: 'users' | 'groups',
  libraryId: number | string,
  since?: number
): Promise<{ items: any[]; version: number }> {
  const limit = 100;
  let start = 0;
  const allItems: any[] = [];
  let libraryVersion = 0;

  const sinceParam = since !== undefined ? `&since=${since}` : '';

  while (true) {
    const apiPath =
      `/api/${libraryType}/${libraryId}/items` +
      `?format=json&itemType=-attachment&limit=${limit}&start=${start}${sinceParam}`;

    const { data, version } = await zoteroNativeGet(port, apiPath);
    libraryVersion = version;

    if (!Array.isArray(data) || data.length === 0) break;

    allItems.push(...data);
    if (data.length < limit) break;
    start += limit;
  }

  return { items: allItems, version: libraryVersion };
}

const ZOTERO_TYPE_TO_CSL: Record<string, string> = {
  artwork: 'graphic',
  audioRecording: 'song',
  bill: 'bill',
  blogPost: 'post-weblog',
  book: 'book',
  bookSection: 'chapter',
  case: 'legal_case',
  computerProgram: 'software',
  conferencePaper: 'paper-conference',
  dataset: 'dataset',
  dictionaryEntry: 'entry-dictionary',
  document: 'document',
  email: 'personal_communication',
  encyclopediaArticle: 'entry-encyclopedia',
  film: 'motion_picture',
  forumPost: 'post',
  hearing: 'hearing',
  instantMessage: 'personal_communication',
  interview: 'interview',
  journalArticle: 'article-journal',
  letter: 'personal_communication',
  magazineArticle: 'article-magazine',
  manuscript: 'manuscript',
  map: 'map',
  newspaperArticle: 'article-newspaper',
  patent: 'patent',
  podcast: 'broadcast',
  presentation: 'speech',
  radioBroadcast: 'broadcast',
  report: 'report',
  statute: 'legislation',
  thesis: 'thesis',
  tvBroadcast: 'broadcast',
  videoRecording: 'motion_picture',
  webpage: 'webpage',
};

function parseZoteroDate(dateStr: string): any {
  if (!dateStr) return undefined;
  const fullMatch = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (fullMatch) {
    return {
      'date-parts': [
        [Number(fullMatch[1]), Number(fullMatch[2]), Number(fullMatch[3])],
      ],
    };
  }
  const yearMonthMatch = dateStr.match(/(\d{4})-(\d{2})/);
  if (yearMonthMatch) {
    return {
      'date-parts': [[Number(yearMonthMatch[1]), Number(yearMonthMatch[2])]],
    };
  }
  const yearMatch = dateStr.match(/(\d{4})/);
  if (yearMatch) {
    return { 'date-parts': [[Number(yearMatch[1])]] };
  }
  return { raw: dateStr };
}

function zoteroCreatorToCSL(creator: any): any {
  if (creator.name) return { literal: creator.name };
  const result: any = {};
  if (creator.lastName) result.family = creator.lastName;
  if (creator.firstName) result.given = creator.firstName;
  return result;
}

const CREATOR_TYPE_TO_CSL_ROLE: Record<string, string> = {
  author: 'author',
  editor: 'editor',
  translator: 'translator',
  contributor: 'contributor',
  bookAuthor: 'container-author',
  seriesEditor: 'collection-editor',
  director: 'director',
  interviewer: 'interviewer',
  interviewee: 'author',
  composer: 'composer',
  producer: 'producer',
  scriptwriter: 'script-writer',
  reviewedAuthor: 'reviewed-author',
  performer: 'performer',
  wordsBy: 'lyricist',
  recipient: 'recipient',
  witness: 'witness',
  castMember: 'performer',
};

/** Convert a single Zotero item (format=json) to a PartialCSLEntry. Returns null if no citationKey. */
export function zoteroItemToCSL(
  item: any,
  groupId: number
): PartialCSLEntry | null {
  const data = item.data;
  if (!data?.citationKey) return null;

  const cslItem: any = {
    id: data.citationKey,
    type: ZOTERO_TYPE_TO_CSL[data.itemType] || 'document',
    groupID: groupId,
  };

  if (data.title) cslItem.title = data.title;

  if (data.creators?.length) {
    const byRole: Record<string, any[]> = {};
    for (const creator of data.creators) {
      const role = CREATOR_TYPE_TO_CSL_ROLE[creator.creatorType] || 'author';
      if (!byRole[role]) byRole[role] = [];
      byRole[role].push(zoteroCreatorToCSL(creator));
    }
    for (const [role, names] of Object.entries(byRole)) {
      cslItem[role] = names;
    }
  }

  if (data.date) cslItem.issued = parseZoteroDate(data.date);

  // Container title (first truthy wins)
  const containerTitle =
    data.publicationTitle ||
    data.bookTitle ||
    data.encyclopediaTitle ||
    data.dictionaryTitle ||
    data.blogTitle ||
    data.websiteTitle ||
    data.forumTitle ||
    data.proceedingsTitle ||
    data.programTitle;
  if (containerTitle) cslItem['container-title'] = containerTitle;
  if (data.journalAbbreviation)
    cslItem['container-title-short'] = data.journalAbbreviation;

  if (data.volume) cslItem.volume = data.volume;
  if (data.issue) cslItem.issue = data.issue;
  if (data.pages) cslItem.page = data.pages;
  if (data.numberOfVolumes) cslItem['number-of-volumes'] = data.numberOfVolumes;
  if (data.numberOfPages) cslItem['number-of-pages'] = data.numberOfPages;
  if (data.edition) cslItem.edition = data.edition;

  if (data.publisher) cslItem.publisher = data.publisher;
  if (data.institution) cslItem.publisher = data.institution;
  if (data.university) cslItem.publisher = data.university;
  if (data.place) cslItem['publisher-place'] = data.place;

  if (data.DOI) cslItem.DOI = data.DOI;
  if (data.URL) cslItem.URL = data.URL;
  if (data.ISBN) cslItem.ISBN = data.ISBN;
  if (data.ISSN) cslItem.ISSN = data.ISSN;
  if (data.callNumber) cslItem['call-number'] = data.callNumber;

  if (data.abstractNote) cslItem.abstract = data.abstractNote;
  if (data.language) cslItem.language = data.language;

  if (data.thesisType) cslItem.genre = data.thesisType;
  if (data.reportType) cslItem.genre = data.reportType;
  if (data.reportNumber) cslItem.number = data.reportNumber;
  if (data.patentNumber) cslItem.number = data.patentNumber;
  if (data.country) cslItem.jurisdiction = data.country;
  if (data.applicationNumber) cslItem['call-number'] = data.applicationNumber;

  if (data.series) cslItem['collection-title'] = data.series;
  if (data.seriesTitle) cslItem['collection-title'] = data.seriesTitle;
  if (data.seriesNumber) cslItem['collection-number'] = data.seriesNumber;

  if (data.conferenceName) cslItem['event-title'] = data.conferenceName;
  if (data.section) cslItem.section = data.section;

  return cslItem as PartialCSLEntry;
}

/** groupId=1 means "My Library" (users/0); any other positive ID is a group library. */
function nativeLibraryCoords(
  groupId: number
): { libraryType: 'users' | 'groups'; libraryId: number | string } {
  return groupId === 1
    ? { libraryType: 'users', libraryId: 0 }
    : { libraryType: 'groups', libraryId: groupId };
}

export async function isZoteroRunningNative(
  port: string = DEFAULT_ZOTERO_PORT
): Promise<boolean> {
  try {
    const p = zoteroNativeGet(port, '/api/users/0/items?limit=1');
    const result = await Promise.race<{ data: any; version: number } | null>([
      p,
      new Promise<null>((res) => {
        getGlobal().setTimeout(() => res(null), 2000);
      }),
    ]);
    return result !== null && Array.isArray(result.data);
  } catch {
    return false;
  }
}

export async function getZUserGroupsNative(
  port: string = DEFAULT_ZOTERO_PORT
): Promise<Array<{ id: number; name: string }> | null> {
  if (!(await isZoteroRunningNative(port))) return null;

  const groups: Array<{ id: number; name: string }> = [
    { id: 1, name: 'My Library' },
  ];

  try {
    const { data } = await zoteroNativeGet(port, '/api/users/0/groups');
    if (Array.isArray(data)) {
      for (const g of data) {
        groups.push({ id: g.id, name: g.data?.name ?? `Group ${g.id}` });
      }
    }
  } catch (e) {
    console.error('Error fetching Zotero groups (native API):', e);
  }

  return groups;
}

export async function getZBibNative(
  port: string = DEFAULT_ZOTERO_PORT,
  cacheDir: string,
  groupId: number,
  loadCached?: boolean
): Promise<{ list: CSLList | null; version: number }> {
  const isRunning = await isZoteroRunningNative(port);
  const cached = path.join(cacheDir, `zotero-native-library-${groupId}.json`);

  ensureDir(cacheDir);
  if (loadCached || !isRunning) {
    if (fs.existsSync(cached)) {
      const cacheData = JSON.parse(fs.readFileSync(cached).toString());
      return {
        list: applyGroupID(cacheData.items as CSLList, groupId),
        version: cacheData.version ?? 0,
      };
    }
    if (!isRunning) return { list: null, version: 0 };
  }

  const { libraryType, libraryId } = nativeLibraryCoords(groupId);
  const { items: rawItems, version } = await fetchAllZoteroItemsNative(
    port,
    libraryType,
    libraryId
  );

  const cslItems: PartialCSLEntry[] = [];
  for (const rawItem of rawItems) {
    const cslItem = zoteroItemToCSL(rawItem, groupId);
    if (cslItem) cslItems.push(cslItem);
  }

  fs.writeFileSync(cached, JSON.stringify({ items: cslItems, version }));

  return { list: applyGroupID(cslItems, groupId), version };
}

export async function refreshZBibNative(
  port: string = DEFAULT_ZOTERO_PORT,
  cacheDir: string,
  groupId: number,
  sinceVersion: number
): Promise<{ list: CSLList; modified: Map<string, PartialCSLEntry> } | null> {
  if (!(await isZoteroRunningNative(port))) return null;

  const cached = path.join(cacheDir, `zotero-native-library-${groupId}.json`);
  ensureDir(cacheDir);
  if (!fs.existsSync(cached)) return null;

  const { libraryType, libraryId } = nativeLibraryCoords(groupId);
  const { items: rawItems, version } = await fetchAllZoteroItemsNative(
    port,
    libraryType,
    libraryId,
    sinceVersion
  );

  if (!rawItems?.length) return null;

  const modified: Map<string, PartialCSLEntry> = new Map();
  const newKeys: Set<string> = new Set();

  for (const rawItem of rawItems) {
    const cslItem = zoteroItemToCSL(rawItem, groupId);
    if (!cslItem?.id) continue;
    modified.set(cslItem.id, cslItem);
    newKeys.add(cslItem.id);
  }

  const cacheData = JSON.parse(fs.readFileSync(cached).toString());
  const list = cacheData.items as CSLList;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (modified.has(item.id)) {
      newKeys.delete(item.id);
      list[i] = modified.get(item.id);
    }
  }
  for (const key of newKeys) {
    list.push(modified.get(key));
  }

  fs.writeFileSync(cached, JSON.stringify({ items: list, version }));

  return { list: applyGroupID(list, groupId), modified };
}

export async function getItemJSONFromCiteKeysNative(
  port: string = DEFAULT_ZOTERO_PORT,
  citeKeys: string[],
  libraryID: number
): Promise<any[] | null> {
  if (!(await isZoteroRunningNative(port))) return null;

  const { libraryType, libraryId } = nativeLibraryCoords(libraryID);
  const results: any[] = [];

  for (const citeKey of citeKeys) {
    try {
      const searchPath =
        `/api/${libraryType}/${libraryId}/items` +
        `?format=json&q=${encodeURIComponent(citeKey)}&limit=10`;
      const { data } = await zoteroNativeGet(port, searchPath);

      if (!Array.isArray(data)) continue;

      const match = data.find(
        (item: any) => item.data?.citationKey === citeKey
      );
      if (!match) continue;

      const itemKey = match.key;
      const selectUrl =
        libraryID === 1
          ? `zotero://select/library/items/${itemKey}`
          : `zotero://select/groups/${libraryID}/items/${itemKey}`;

      // Fetch PDF attachments for this item
      const attPath =
        `/api/${libraryType}/${libraryId}/items/${itemKey}/children` +
        `?format=json&itemType=attachment`;
      const { data: children } = await zoteroNativeGet(port, attPath);

      const attachments = Array.isArray(children)
        ? children
            .filter(
              (c: any) =>
                c.data?.contentType === 'application/pdf' && c.data?.path
            )
            .map((c: any) => ({ path: c.data.path }))
        : [];

      results.push({
        citekey: citeKey,
        citationKey: citeKey,
        select: selectUrl,
        attachments,
      });
    } catch {
      // skip individual failures
    }
  }

  return results.length ? results : null;
}

// ─── BBT (Better BibTeX) API ──────────────────────────────────────────────────

export async function getItemJSONFromCiteKeys(
  port: string = DEFAULT_ZOTERO_PORT,
  citeKeys: string[],
  libraryID: number
) {
  if (!(await isZoteroRunning(port))) return null;

  let res: any;
  try {
    res = await new Promise((res, rej) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'item.export',
        params: [citeKeys, '36a3b0b5-bad0-4a04-b79b-441c7cef77db', libraryID],
      });

      const postRequest = request(
        {
          host: '127.0.0.1',
          port: port,
          path: '/better-bibtex/json-rpc',
          method: 'POST',
          headers: {
            ...defaultHeaders,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (result) => {
          let output = '';

          result.setEncoding('utf8');
          result.on('data', (chunk) => (output += chunk));
          result.on('error', (e) => rej(`Error connecting to Zotero: ${e}`));
          result.on('close', () => {
            rej(new Error('Error: cannot connect to Zotero'));
          });
          result.on('end', () => {
            try {
              res(JSON.parse(output));
            } catch (e) {
              rej(e);
            }
          });
        }
      );

      postRequest.write(body);
      postRequest.end();
    });
  } catch (e) {
    console.error(e);
    return null;
  }

  try {
    if (res.error?.message) {
      console.error(new Error(res.error.message));
      return null;
    }

    return Array.isArray(res.result)
      ? JSON.parse(res.result[2]).items
      : JSON.parse(res.result).items;
  } catch (e) {
    console.error(e);
    return null;
  }
}
