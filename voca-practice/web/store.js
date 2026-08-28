// Local-first storage + Mac sync.
//
// On iOS there is no Python process to talk to, so every write lands in
// localStorage first and the Mac is reconciled later, on demand. Records carry
// `updated_at` and a `deleted` tombstone so the merge in run.py can resolve the
// two sides without resurrecting words the user has already graduated.
//
// Timestamps use Date.toISOString(), which run.py's utc_now_iso() mirrors
// byte-for-byte — both sides compare them as plain strings.

const Store = (() => {
    const K_INCORRECT = 'voca_incorrect_v2';
    const K_MASTERED = 'voca_mastered_v2';
    const K_WORDS = 'voca_words_v2';
    const K_SERVER = 'voca_server_url';
    const K_LAST_SYNC = 'voca_last_sync';

    const DEFAULT_SERVER = 'http://dykimMacBook-Pro.local:8080';
    const SYNC_TIMEOUT_MS = 8000;

    const now = () => new Date().toISOString();

    function read(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            console.error(`Corrupt localStorage key ${key}, resetting:`, e);
            return fallback;
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.error(`Failed to persist ${key}:`, e);
        }
    }

    // --- Incorrect words (오답노트) ---

    const allIncorrect = () => read(K_INCORRECT, []);

    function getIncorrect() {
        return allIncorrect()
            .filter(w => !w.deleted)
            .map(w => ({ english: w.english, korean: w.korean, category: w.category }));
    }

    function recordIncorrect(word, fallbackCategory) {
        const list = allIncorrect();
        const stamp = now();
        const localDate = new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 19);
        const existing = list.find(w => w.english === word.english);

        if (existing) {
            // Missing it again revives a graduated word and keeps its running count.
            existing.wrong_count = (existing.wrong_count || 0) + 1;
            existing.korean = word.korean;
            existing.category = word.category || fallbackCategory || existing.category;
            existing.last_wrong_date = localDate;
            existing.updated_at = stamp;
            existing.deleted = false;
        } else {
            list.push({
                english: word.english,
                korean: word.korean,
                category: word.category || fallbackCategory || '',
                wrong_count: 1,
                last_wrong_date: localDate,
                updated_at: stamp,
                deleted: false
            });
        }
        write(K_INCORRECT, list);
    }

    function graduateIncorrect(english) {
        const list = allIncorrect();
        const existing = list.find(w => w.english === english);
        if (!existing || existing.deleted) return false;
        existing.deleted = true;
        existing.updated_at = now();
        write(K_INCORRECT, list);
        return true;
    }

    /** Seed from the bundled data.json on very first launch, before any sync. */
    function seedIncorrectIfEmpty(seedList) {
        if (allIncorrect().length || !seedList || !seedList.length) return;
        write(K_INCORRECT, seedList.map(w => ({
            english: w.english,
            korean: w.korean,
            category: w.category || '',
            wrong_count: 1,
            last_wrong_date: '',
            updated_at: new Date(0).toISOString(),
            deleted: false
        })));
    }

    // --- Mastered words ---

    const allMastered = () => read(K_MASTERED, []);

    function getMasteredSet() {
        return new Set(allMastered().filter(w => !w.deleted).map(w => w.english));
    }

    function setMastered(english, isMastered) {
        const list = allMastered();
        const existing = list.find(w => w.english === english);
        if (existing) {
            const currentlyMastered = !existing.deleted;
            if (currentlyMastered === isMastered) return;
            existing.deleted = !isMastered;
            existing.updated_at = now();
        } else {
            list.push({ english, updated_at: now(), deleted: !isMastered });
        }
        write(K_MASTERED, list);
    }

    /** One-time lift of the pre-sync `mastered_words` key into timestamped records. */
    function migrateLegacyMastered() {
        const legacy = localStorage.getItem('mastered_words');
        if (!legacy || allMastered().length) return;
        try {
            const names = JSON.parse(legacy);
            if (!Array.isArray(names) || !names.length) return;
            write(K_MASTERED, names.map(english => ({
                english,
                updated_at: new Date(0).toISOString(),
                deleted: false
            })));
            console.log(`Migrated ${names.length} mastered words to the sync store.`);
        } catch (e) {
            console.error('Legacy mastered_words migration failed:', e);
        }
    }

    // --- Vocabulary cache ---

    const getWords = () => read(K_WORDS, null);
    const setWords = words => write(K_WORDS, words);

    // --- Server settings ---

    const getServerUrl = () => localStorage.getItem(K_SERVER) || DEFAULT_SERVER;
    const setServerUrl = url => localStorage.setItem(K_SERVER, String(url || '').trim().replace(/\/+$/, ''));
    const getLastSync = () => localStorage.getItem(K_LAST_SYNC);

    async function request(path, options = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
        try {
            const res = await fetch(getServerUrl() + path, { ...options, signal: controller.signal });
            if (!res.ok) throw new Error(`서버가 ${res.status} 응답을 보냈습니다`);
            return await res.json();
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('서버 응답이 없습니다 (시간 초과)');
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * One round trip does both directions: push local state, receive the merged
     * result, adopt it wholesale. Safe to run at any time — offline edits simply
     * wait for the next successful call.
     */
    async function sync() {
        const data = await request('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                incorrect: allIncorrect(),
                mastered: allMastered()
            })
        });

        if (Array.isArray(data.incorrect)) write(K_INCORRECT, data.incorrect);
        if (Array.isArray(data.mastered)) write(K_MASTERED, data.mastered);
        if (data.words && Object.keys(data.words).length) setWords(data.words);
        localStorage.setItem(K_LAST_SYNC, now());
        return data;
    }

    /** Writes the 오답노트 sheet back into the Mac's .xlsx. Requires the server. */
    const exportToExcel = () => request('/api/export', { method: 'POST' });

    return {
        getIncorrect, recordIncorrect, graduateIncorrect, seedIncorrectIfEmpty,
        getMasteredSet, setMastered, migrateLegacyMastered,
        getWords, setWords,
        getServerUrl, setServerUrl, getLastSync, DEFAULT_SERVER,
        sync, exportToExcel
    };
})();
