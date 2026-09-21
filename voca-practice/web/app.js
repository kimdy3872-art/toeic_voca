// App State
let db = {};
let selectedCategory = 'all';
let currentWords = [];
let allWordsPool = []; // flat list of every word across all normal categories (used as distractor source)
Store.migrateLegacyMastered();
let masteredWords = Store.getMasteredSet();

// Study State
let studyIndex = 0;
let isFlipped = false;

// Tracing State
let tracingIndex = 0;
let tracingHints = true;                    // show the letters to trace over? (set during init)
let tracingDone = new Set();                // indices finished in the current category
                                            // (indices, not words: 전체 DAY repeats a
                                            // handful of words across two days)
let tracingAdvanceTimer = null;
let tracingRevealTimer = null;
let tracingPhoneticToken = 0;

// Quiz State
let quizDirection = 'eng-to-kor'; // 'eng-to-kor' or 'kor-to-eng'
let quizType = 'choice'; // 'choice' or 'write'
let quizRange = 'all'; // 'all', 'incorrect', or 'review' (today's due words)
let quizFullRange = false; // when true, ignore the 10-question cap and quiz every word in range
let quizIndex = 0;
let quizWords = [];
let quizScore = 0;
let quizSelectedAnswers = []; // track correct/incorrect
let currentQuizCorrectIndex = -1;
let currentQuizOptions = [];
let selectedOptionIdx = -1;

// DOM Elements
const views = {
    dashboard: document.getElementById('view-dashboard'),
    study: document.getElementById('view-study'),
    quiz: document.getElementById('view-quiz'),
    tracing: document.getElementById('view-tracing')
};

const navBtns = {
    dashboard: document.getElementById('nav-btn-dashboard'),
    study: document.getElementById('nav-btn-study'),
    quiz: document.getElementById('nav-btn-quiz'),
    tracing: document.getElementById('nav-btn-tracing')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    tracingHints = loadTracingHintPref();
    loadData();
    setupKeyboardShortcuts();
    updateSyncStatus();
    applyTouchCopy();

    // Opportunistic catch-up: if the Mac happens to be reachable, start the session
    // already merged. Failure is silent — being away from the Mac is the normal case.
    setTimeout(() => syncNow(true), 800);
});

const isPhoneLayout = () => window.matchMedia('(max-width: 768px)').matches;

// Keyboard hints are baked into the markup for the desktop build; on a phone
// there is no Space key to press.
function applyTouchCopy() {
    if (!isPhoneLayout()) return;
    const hints = document.querySelectorAll('.card-hint');
    if (hints[0]) hints[0].textContent = '카드를 탭하여 뜻을 확인하세요';
    if (hints[1]) hints[1].textContent = '카드를 탭하여 다시 영단어를 확인하세요';

    const submitBtn = document.getElementById('quiz-choice-submit-btn');
    if (submitBtn) submitBtn.textContent = '선택 완료';

    const typingSubmit = document.querySelector('#quiz-input-container .submit-answer-btn');
    if (typingSubmit) typingSubmit.textContent = '제출';
}

// Setup Keyboard Shortcuts for Study and Quiz Modes
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const overlay = document.getElementById('settings-overlay');
        if (overlay && overlay.classList.contains('open')) {
            if (e.code === 'Escape') closeSettings();
            return;
        }

        if (views.study.classList.contains('active')) {
            if (e.code === 'Space') {
                e.preventDefault();
                flipCard();
            } else if (e.code === 'ArrowLeft') {
                prevWord();
            } else if (e.code === 'ArrowRight') {
                nextWord();
            } else if (e.code === 'Enter') {
                e.preventDefault();
                const currentWord = currentWords[studyIndex];
                if (currentWord) {
                    speak(currentWord.english);
                }
            }
        } else if (views.tracing.classList.contains('active')) {
            // While the field has focus its own handler owns every key.
            if (document.activeElement === document.getElementById('tracing-input')) return;

            if (e.code === 'ArrowLeft') {
                e.preventDefault();
                prevTracingWord();
            } else if (e.code === 'ArrowRight') {
                e.preventDefault();
                nextTracingWord();
            } else if (e.code === 'Enter') {
                // Clicking elsewhere drops focus; Enter is how you get back to typing.
                e.preventDefault();
                focusTracingInput();
            }
        } else if (views.quiz.classList.contains('active')) {
            const quizScreen = document.getElementById('quiz-screen');
            if (quizScreen && quizScreen.style.display === 'block') {
                const word = quizWords[quizIndex];
                if (!word) return;

                // Handle arrow keys navigation first, check if typing is currently active
                const typingInput = document.getElementById('quiz-typing-input');
                const isTypingActive = (document.activeElement === typingInput && !typingInput.disabled);
                
                if (!isTypingActive) {
                    if (e.code === 'ArrowLeft') {
                        e.preventDefault();
                        prevQuizQuestion();
                    } else if (e.code === 'ArrowRight') {
                        e.preventDefault();
                        if (word.isAnswered) {
                            nextQuizQuestion();
                        }
                    }
                }

                // Handle choices or enter confirmation
                if (quizType === 'choice') {
                    if (!word.isAnswered) {
                        // Keyed off the rendered option count, which shrinks below
                        // QUIZ_OPTION_COUNT when the word pool cannot fill it.
                        const pressed = parseInt(e.key, 10);
                        if (pressed >= 1 && pressed <= currentQuizOptions.length) {
                            e.preventDefault();
                            selectChoiceOption(pressed - 1);
                        } else if (e.code === 'Enter') {
                            e.preventDefault();
                            if (selectedOptionIdx !== -1) {
                                submitChoiceAnswer();
                            }
                        }
                    } else {
                        if (e.code === 'Enter') {
                            e.preventDefault();
                            nextQuizQuestion();
                        }
                    }
                } else if (quizType === 'write') {
                    if (word.isAnswered && e.code === 'Enter') {
                        e.preventDefault();
                        nextQuizQuestion();
                    }
                }
            }
        }
    });
}

// Load vocabulary. A previous sync's copy wins over the bundled data.json, which
// on iOS is frozen at whatever was current when the app was last built.
async function loadData() {
    try {
        let words = Store.getWords();

        if (!words) {
            const response = await fetch('data.json');
            const bundled = await response.json();
            Store.seedIncorrectIfEmpty(bundled['오답노트']);
            words = {};
            Object.keys(bundled).forEach(cat => {
                if (cat !== '오답노트') words[cat] = bundled[cat];
            });
            Store.setWords(words);
        }

        applyWords(words);
    } catch (error) {
        console.error('Failed to load vocabulary data:', error);
        alert('단어 데이터를 불러오는 데 실패했습니다.');
    }
}

// Rebuild every derived view from a vocabulary map plus the local 오답노트.
function applyWords(words) {
    db = { ...words };
    db['오답노트'] = Store.getIncorrect();

    allWordsPool = [];
    Object.keys(db).forEach(cat => {
        if (cat !== '오답노트') {
            allWordsPool.push(...db[cat].map(w => ({ ...w, category: cat })));
        }
    });

    const previousCategory = selectedCategory;
    populateCategories();
    const select = document.getElementById('category-select');
    if (previousCategory && [...select.options].some(o => o.value === previousCategory)) {
        select.value = previousCategory;
    }
    onCategoryChange();
    updateDashboard();
}

// Refresh only the parts that depend on 오답노트, without disturbing the current view.
function refreshIncorrectViews() {
    db['오답노트'] = Store.getIncorrect();
    updateDashboard();          // also refreshes the 오늘 복습 badge
    updateQuizConfigUI();
}

// Populate Category Dropdown
function populateCategories() {
    const select = document.getElementById('category-select');
    select.innerHTML = '<option value="all">전체 DAY</option>';
    
    Object.keys(db).forEach(category => {
        // 오답노트 is now always present in `db`, so hide the entry while it's empty
        // rather than offering a category that would quiz on nothing.
        if (category === '오답노트' && !db['오답노트'].length) return;
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category === '오답노트' ? '🚨 오답노트 (복습)' : category;
        select.appendChild(option);
    });
}

// Handle Category Selection Change
function onCategoryChange() {
    selectedCategory = document.getElementById('category-select').value;
    
    if (selectedCategory === 'all') {
        currentWords = [];
        Object.keys(db).forEach(cat => {
            if (cat !== '오답노트') {
                currentWords.push(...db[cat].map(w => ({...w, category: cat})));
            }
        });
    } else {
        currentWords = db[selectedCategory].map(w => ({...w, category: w.category || selectedCategory}));
    }
    
    // Reset Study indices
    studyIndex = 0;
    tracingIndex = 0;
    tracingDone.clear();
    isFlipped = false;
    
    const card = document.getElementById('flashcard');
    if (card) card.classList.remove('flipped');
    
    updateStudyUI();
    if (views.tracing && views.tracing.classList.contains('active')) updateTracingUI();
    updateDashboard();
    updateQuizConfigUI();
}

// Update Dashboard Statistics
function updateDashboard() {
    const totalWords = currentWords.length;
    document.getElementById('stat-total-words').textContent = totalWords;
    
    // Count mastered words in current category
    const masteredInCat = currentWords.filter(w => masteredWords.has(w.english)).length;
    document.getElementById('stat-mastered-words').textContent = masteredInCat;
    
    // Incorrect words count (unique count from '오답노트' sheet if it exists, otherwise 0)
    const incorrectCount = db['오답노트'] ? db['오답노트'].length : 0;
    document.getElementById('stat-incorrect-words').textContent = incorrectCount;
    
    updateReviewEntry();

    // Render Day progress list
    const progressList = document.getElementById('progress-list');
    progressList.innerHTML = '';
    
    Object.keys(db).forEach(cat => {
        if (cat === '오답노트') return; // Skip incorrect sheet in progress list
        
        const catWords = db[cat];
        const catTotal = catWords.length;
        const catMastered = catWords.filter(w => masteredWords.has(w.english)).length;
        const percent = catTotal > 0 ? Math.round((catMastered / catTotal) * 100) : 0;
        
        const item = document.createElement('div');
        item.className = 'progress-item';
        item.innerHTML = `
            <div class="progress-label-row">
                <span class="progress-name">${cat}</span>
                <span class="progress-percentage">${catMastered}/${catTotal} (${percent}%)</span>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill" style="width: ${percent}%"></div>
            </div>
        `;
        progressList.appendChild(item);
    });
}

// Switch between View Panels
function switchView(viewName) {
    // Deactivate all views
    Object.keys(views).forEach(key => {
        views[key].classList.remove('active');
        navBtns[key].classList.remove('active');
    });
    
    // Activate target view
    views[viewName].classList.add('active');
    navBtns[viewName].classList.add('active');
    
    // Update Header Text
    const titleEl = document.getElementById('view-title');
    const subtitleEl = document.getElementById('view-subtitle');
    
    if (viewName === 'dashboard') {
        titleEl.textContent = '학습 대시보드';
        subtitleEl.textContent = '나의 단어 학습 상태를 모니터링합니다.';
        updateDashboard();
    } else if (viewName === 'study') {
        titleEl.textContent = '카드 암기학습';
        subtitleEl.textContent = '카드 뒷면을 확인하며 영단어의 발음과 뜻을 암기합니다.';
        updateStudyUI();
    } else if (viewName === 'tracing') {
        titleEl.textContent = '단어 따라쓰기';
        subtitleEl.textContent = '뜻을 보고 철자를 따라 쓰며 스펠링을 익힙니다.';
        updateTracingUI();
    } else if (viewName === 'quiz') {
        titleEl.textContent = '연습 퀴즈';
        subtitleEl.textContent = '영어 ➔ 한국어 혹은 한국어 ➔ 영어 테스트를 진행합니다.';
        // Reset quiz screen to config card
        restartQuizSetup();
    }
}

/* ================= STUDY MODE ================= */
function updateStudyUI() {
    const wordEl = document.getElementById('card-word');
    const phoneticEl = document.getElementById('card-phonetic');
    const translationEl = document.getElementById('card-translation');
    const indexEl = document.getElementById('study-index');
    const totalEl = document.getElementById('study-total');
    const catFront = document.getElementById('card-cat-front');
    const catBack = document.getElementById('card-cat-back');
    
    totalEl.textContent = currentWords.length;
    
    if (currentWords.length === 0) {
        wordEl.textContent = '단어 없음';
        if (phoneticEl) phoneticEl.textContent = '';
        translationEl.textContent = '선택된 카테고리에 단어가 없습니다.';
        indexEl.textContent = 0;
        catFront.textContent = '-';
        catBack.textContent = '-';
        return;
    }
    
    indexEl.textContent = studyIndex + 1;
    
    const word = currentWords[studyIndex];
    wordEl.textContent = word.english;
    if (phoneticEl) {
        phoneticEl.textContent = ''; // clear initially
        getPhoneticData(word.english).then(data => {
            if (phoneticEl && data.text) {
                phoneticEl.textContent = data.text;
            }
        });
    }
    translationEl.textContent = word.korean;
    catFront.textContent = word.category || selectedCategory;
    catBack.textContent = word.category || selectedCategory;
    
    isFlipped = false;
    document.getElementById('flashcard').classList.remove('flipped');
}

function flipCard() {
    if (currentWords.length === 0) return;
    isFlipped = !isFlipped;
    document.getElementById('flashcard').classList.toggle('flipped');
}

function prevWord() {
    if (currentWords.length === 0) return;
    studyIndex = (studyIndex - 1 + currentWords.length) % currentWords.length;
    updateStudyUI();
}

function nextWord() {
    if (currentWords.length === 0) return;

    // Auto master previous card when clicking next? Let's just track current index
    studyIndex = (studyIndex + 1) % currentWords.length;
    updateStudyUI();
}

function speakWord(event) {
    if (event) event.stopPropagation(); // prevent flipping card when clicking speaker
    if (currentWords.length === 0) return;
    speak(currentWords[studyIndex].english);
}

// word -> Promise<{audio, text}>. Caching the promise (not just the result) means
// the phonetic display and speak() share one request instead of firing two.
const audioCache = {};

// Every speak() request takes the next token. Anything started by an older token
// (a late-arriving fetch, an audio error handler) is discarded, so only the most
// recent request is ever heard.
let speakToken = 0;
let currentAudio = null;

function getPhoneticData(word) {
    if (audioCache[word]) return audioCache[word];

    const request = (async () => {
        try {
            const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
            if (!res.ok) throw new Error('not found');
            const data = await res.json();

            let usAudio = '';
            let phoneticText = data[0].phonetic || '';

            for (const entry of data) {
                if (entry.phonetics) {
                    for (const p of entry.phonetics) {
                        if (p.audio && p.audio.includes('-us.mp3')) {
                            usAudio = p.audio;
                            if (p.text) phoneticText = p.text;
                        }
                    }
                    if (!usAudio) {
                        for (const p of entry.phonetics) {
                            if (p.audio) {
                                usAudio = p.audio;
                                if (p.text && !phoneticText) phoneticText = p.text;
                                break;
                            }
                        }
                    }
                }
            }
            return { audio: usAudio, text: phoneticText };
        } catch (e) {
            return { audio: '', text: '' };
        }
    })();

    audioCache[word] = request;
    return request;
}

// Silence whatever is currently playing or queued, and invalidate pending requests.
function stopSpeaking() {
    speakToken++;
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

async function speak(text) {
    if (!text) return;

    // A new request always supersedes the previous one - never stack playbacks.
    stopSpeaking();
    const token = speakToken;

    const data = await getPhoneticData(text);
    if (token !== speakToken) return; // superseded while the lookup was in flight

    if (!data.audio) {
        fallbackSpeak(text, token);
        return;
    }

    const audio = new Audio(data.audio);
    currentAudio = audio;

    // The mp3 and the TTS fallback must never both be heard: fall back at most
    // once, and only if playback never actually started.
    let settled = false;
    const fallbackOnce = () => {
        if (settled || token !== speakToken) return;
        settled = true;
        fallbackSpeak(text, token);
    };
    audio.addEventListener('playing', () => { settled = true; });
    audio.addEventListener('error', fallbackOnce);
    audio.play().catch(fallbackOnce);
}

function fallbackSpeak(text, token) {
    if (!('speechSynthesis' in window)) return;
    if (token !== undefined && token !== speakToken) return;

    // speak() already cancelled via stopSpeaking(); cancelling again right before
    // speak() is what makes Chrome occasionally repeat or drop an utterance.
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';

    const voices = window.speechSynthesis.getVoices();
    const usVoice = voices.find(v => v.lang === 'en-US' && v.name.includes('Google')) ||
                    voices.find(v => v.lang === 'en-US' && v.name.includes('Samantha')) ||
                    voices.find(v => v.lang === 'en-US');
    if (usVoice) utterance.voice = usVoice;

    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
}


/* ================= QUIZ MODE ================= */
// Unbiased Fisher-Yates shuffle (Array.sort(() => Math.random() - 0.5) is statistically skewed)
function shuffleArray(arr) {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

// Split a Korean gloss into its separate meanings. Separators inside parentheses are
// ignored, so "(직위, 직책 등을) 승계할 것이다, 뒤를 이을것이다" yields 2 meanings, not 3.
function splitKoreanMeanings(koreanText) {
    const meanings = [];
    let depth = 0;
    let buffer = '';

    for (const ch of koreanText) {
        if (ch === '(' || ch === '（') depth++;
        else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);

        if (depth === 0 && (ch === ',' || ch === ';')) {
            meanings.push(buffer.trim());
            buffer = '';
        } else {
            buffer += ch;
        }
    }
    meanings.push(buffer.trim());

    const cleaned = meanings.filter(Boolean);
    return cleaned.length > 0 ? cleaned : [koreanText.trim()];
}

// Normalized form used to tell whether two options would read as the same meaning:
// "(값, 가치가) 하락하다" and "하락하다" must count as a collision.
function meaningKey(text) {
    return text.replace(/\([^)]*\)/g, '').replace(/[~\s]/g, '');
}

// Every meaning a word carries, normalized. Options show a word's *complete* gloss, so
// two words are interchangeable as answers only when these sets are identical.
function meaningKeySet(koreanText) {
    return new Set(splitKoreanMeanings(koreanText).map(meaningKey));
}

function sameMeaningSet(a, b) {
    return a.size === b.size && [...a].every(m => b.has(m));
}

function sharesMeaning(a, b) {
    return [...a].some(m => b.has(m));
}

// Rough part-of-speech class guessed from how a Korean gloss ends. Used so distractors
// share the answer's grammatical shape ("조사하다" next to "장비" gives the answer away).
function koreanPosClass(text) {
    const gloss = text.replace(/\([^)]*\)/g, '').replace(/~/g, '').trim();
    if (/다$/.test(gloss)) return 'verb';
    if (/[로히게]$/.test(gloss)) return 'adverb';
    // adnominal endings: 유망한 / 창조적인 / 제한된 / 증가하는 / 알맞은 / 뛰어난 / 힘든 / 추가의
    if (/[한인된운는은른난큰든쁜의]$/.test(gloss)) return 'adjective';
    return 'noun';
}

function koreanPosClasses(koreanText) {
    return new Set(splitKoreanMeanings(koreanText).map(koreanPosClass));
}

// Derivational / spelling lookalikes: indicate · indication · indicator,
// satisfaction · satisfactory, comprehensive · comprehensible. Part 5 traps on exactly
// these, so they are the best distractors available whenever the options are English.
// 79 such pairs exist in the current data, covering 102 of the 412 single-token words.
function isConfusable(a, b) {
    if (a.includes(' ') || b.includes(' ')) return false;
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    if (x === y || x.length < 6 || y.length < 6) return false;
    let shared = 0;
    while (shared < x.length && shared < y.length && x[shared] === y[shared]) shared++;
    return shared >= 5;
}

// 정답 1 + 오답 3. 단어 풀이 이보다 작으면 선지 수가 알아서 줄어든다.
const QUIZ_OPTION_COUNT = 4;
// 파생어 오답이 선지를 다 채우면 뜻을 묻는 문제가 아니라 어형 문제가 되어버린다.
const MAX_CONFUSABLE_DISTRACTORS = 2;
// 같은 이유로 뜻 겹치는 오답도 제한한다. 4개 중 3개가 "조사하다"를 달고 있으면
// 어느 쪽이 사전에 그렇게 실렸는지를 묻는 문제가 되지, 뜻을 아는지 묻는 문제가 아니다.
// 1이면 공짜다 — 근접 오답이 붙는 문제 비율은 2일 때와 같은 14% 인데,
// 오답 3개 중 2개가 겹치던 4.4% 의 문제만 사라진다.
const MAX_NEAR_MISS_DISTRACTORS = 1;

// Build the multiple-choice options for a word. Every option carries the word's *complete*
// gloss, which changes what counts as ambiguous: a distractor is a second correct answer
// only when its whole meaning set matches the answer's. Sharing one meaning out of several
// no longer collides — examine "조사하다, 검토하다" against explore "조사하다, 탐험하다"
// still has exactly one right answer, and is the hardest distractor we can offer, so those
// are now deliberately preferred instead of rejected.
//
// Only 3 identical meaning sets exist in the whole vocabulary (exactly/precisely,
// commentary/description, advance/advancement), so unlike the previous
// one-meaning-per-option scheme this practically never runs short of candidates and needs
// no fallback that re-admits ambiguous words.
function buildChoiceOptions(word) {
    const answerMeanings = meaningKeySet(word.korean);
    const answerCount = splitKoreanMeanings(word.korean).length;
    const answerPos = koreanPosClasses(word.korean);
    // Korean options are read in full, so their shape is visible and has to be controlled.
    // English options are single tokens — shape is handled by isConfusable() instead.
    const koreanOptions = quizDirection === 'eng-to-kor';

    const rankDistractor = (candidate) => {
        let score = 0;
        // A near miss forces the learner to know the whole meaning profile rather than one
        // keyword. Only 13% of words have such a partner, so this has to outweigh every
        // shape-matching term below or it gets tied out of the option list and drops to 11%.
        if (sharesMeaning(meaningKeySet(candidate.korean), answerMeanings)) score += 6;
        if (!koreanOptions && isConfusable(candidate.english, word.english)) score += 4;
        // Same DAY, otherwise a word never seen in this DAY is easy to rule out.
        if (word.category && candidate.category === word.category) score += 2;

        if (koreanOptions) {
            // Without these the options become a length puzzle: meaning counts run 1..6 and a
            // lone 3-meaning gloss sitting among 1-meaning ones gives the answer away.
            // Character count matters on top of it — glosses carrying a parenthetical
            // ("(직위, 직책 등을) 승계할 것이다") run to 45 chars at the same meaning count.
            const gap = Math.abs(splitKoreanMeanings(candidate.korean).length - answerCount);
            score += gap === 0 ? 2 : gap === 1 ? 1 : 0;
            const charGap = Math.abs(candidate.korean.length - word.korean.length);
            score += charGap <= 4 ? 2 : charGap <= 10 ? 1 : 0;
            if ([...koreanPosClasses(candidate.korean)].some(p => answerPos.has(p))) score += 1;
        }
        return score;
    };

    // shuffle first so equally ranked candidates stay random (Array.prototype.sort is stable)
    const candidates = shuffleArray(allWordsPool.filter(w => w.english !== word.english))
        .map(candidate => ({ candidate, score: rankDistractor(candidate) }))
        .sort((a, b) => b.score - a.score)
        .map(entry => entry.candidate);

    const wrongOptions = [];
    // a few words appear under more than one DAY, so guard against showing one twice
    const usedEnglish = new Set([word.english]);
    let confusableUsed = 0;
    let nearMissUsed = 0;

    for (const candidate of candidates) {
        if (wrongOptions.length >= QUIZ_OPTION_COUNT - 1) break;
        if (usedEnglish.has(candidate.english)) continue;
        const meanings = meaningKeySet(candidate.korean);
        // an identical meaning set would read as a second correct answer in either direction
        if (sameMeaningSet(meanings, answerMeanings)) continue;

        if (sharesMeaning(meanings, answerMeanings)) {
            if (nearMissUsed >= MAX_NEAR_MISS_DISTRACTORS) continue;
            nearMissUsed++;
        }
        if (!koreanOptions && isConfusable(candidate.english, word.english)) {
            if (confusableUsed >= MAX_CONFUSABLE_DISTRACTORS) continue;
            confusableUsed++;
        }

        usedEnglish.add(candidate.english);
        wrongOptions.push({ ...candidate });
    }

    return shuffleArray([{ ...word }, ...wrongOptions]);
}

// ---------------------------------------------------------------------------
// Today's review (spaced repetition)
// ---------------------------------------------------------------------------

// How many due words one review sitting may ask about. The backfill leaves every
// existing word due on the same day, and a 70-question 4-choice run is a quarter
// of an hour — long enough to push the day's new-word study aside. The badge
// still shows the full due count so the backlog stays visible; the cap only
// decides how much of it is served today, and Store.getDueIncorrect() orders by
// wrong_count first so the slots go to the words that keep failing.
const REVIEW_QUIZ_LIMIT_DEFAULT = 20;
const REVIEW_LIMIT_KEY = 'voca_review_limit';   // per-device preference, deliberately
                                                // outside Store: how many questions
                                                // this device serves is not study
                                                // history and has no place in the
                                                // sync payload (same call as
                                                // voca_tracing_hints).

function getReviewLimit() {
    const raw = parseInt(localStorage.getItem(REVIEW_LIMIT_KEY), 10);
    if (!raw || isNaN(raw) || raw < 1) return REVIEW_QUIZ_LIMIT_DEFAULT;
    return Math.min(raw, 200);
}

function setQuizDirection(direction) {
    quizDirection = direction;
    document.getElementById('chip-dir-eng-to-kor').classList.toggle('active', direction === 'eng-to-kor');
    document.getElementById('chip-dir-kor-to-eng').classList.toggle('active', direction === 'kor-to-eng');
}

function setQuizType(type) {
    quizType = type;
    document.getElementById('chip-type-choice').classList.toggle('active', type === 'choice');
    document.getElementById('chip-type-write').classList.toggle('active', type === 'write');
}

function setQuizRange(range) {
    if (range === 'incorrect') {
        const incorrectCount = getIncorrectWordsForCurrentCategory().length;
        if (incorrectCount === 0) {
            alert('현재 카테고리에 등록된 오답이 없습니다.');
            return;
        }
    }
    quizRange = range;
    document.getElementById('chip-range-all').classList.toggle('active', range === 'all');
    document.getElementById('chip-range-incorrect').classList.toggle('active', range === 'incorrect');
}

function toggleFullRange() {
    quizFullRange = !quizFullRange;
    document.getElementById('chip-full-range').classList.toggle('active', quizFullRange);
}

function getIncorrectWordsForCurrentCategory() {
    const incorrectList = db['오답노트'] || [];
    if (selectedCategory === 'all') {
        return incorrectList;
    } else if (selectedCategory === '오답노트') {
        return incorrectList;
    } else {
        return incorrectList.filter(w => w.category === selectedCategory);
    }
}

function updateQuizConfigUI() {
    const rangeSelectedCatEl = document.getElementById('quiz-range-selected-category');
    const rangeAllCountEl = document.getElementById('quiz-range-all-count');
    const rangeIncorrectCountEl = document.getElementById('quiz-range-incorrect-count');
    
    if (!rangeSelectedCatEl) return;
    
    let catDisplayName = selectedCategory;
    if (selectedCategory === 'all') {
        catDisplayName = '전체 DAY';
    } else if (selectedCategory === '오답노트') {
        catDisplayName = '오답노트';
    }
    
    rangeSelectedCatEl.textContent = catDisplayName;
    
    const totalCount = currentWords.length;
    const incorrectWords = getIncorrectWordsForCurrentCategory();
    const incorrectCount = incorrectWords.length;
    
    rangeAllCountEl.textContent = totalCount;
    rangeIncorrectCountEl.textContent = incorrectCount;
    
    const chipIncorrect = document.getElementById('chip-range-incorrect');
    if (incorrectCount === 0) {
        chipIncorrect.classList.add('disabled');
        if (quizRange === 'incorrect') {
            setQuizRange('all');
        }
    } else {
        chipIncorrect.classList.remove('disabled');
    }
}

function startQuiz() {
    let targetWords = [];
    if (quizRange === 'review') {
        targetWords = Store.getDueIncorrect();
    } else if (quizRange === 'incorrect') {
        targetWords = getIncorrectWordsForCurrentCategory();
    } else {
        targetWords = currentWords;
    }
    
    if (targetWords.length === 0) {
        alert(quizRange === 'review'
            ? '오늘 복습할 단어가 없습니다.'
            : '퀴즈를 시작할 단어가 없습니다.');
        return;
    }
    
    if (quizRange === 'review') {
        // Already ordered most-missed first — take the top N, then shuffle only
        // that slice so the priority picks the words but the run is not
        // predictable.
        quizWords = shuffleArray(targetWords.slice(0, getReviewLimit()));
    } else {
        // Shuffle, then cap at 10 unless "전체 출제" is on
        const shuffled = shuffleArray(targetWords);
        quizWords = quizFullRange ? shuffled : shuffled.slice(0, Math.min(10, shuffled.length));
    }
    
    quizWords.forEach(word => {
        word.isAnswered = false;
        word.selectedOptionIdx = -1;
        word.typedAnswer = '';
        word.isCorrect = null;
        word.shuffledOptions = null;
        word.correctIndex = -1;
    });
    
    quizIndex = 0;
    quizScore = 0;
    quizSelectedAnswers = [];
    
    document.getElementById('quiz-config').style.display = 'none';
    document.getElementById('quiz-results').style.display = 'none';
    document.getElementById('quiz-screen').style.display = 'block';
    
    renderQuizQuestion();
}

/**
 * Dashboard entry point. Forces the 4-choice format the review flow is specified
 * around, then goes straight into the quiz — no config step, since the point is
 * that the app decides what is due.
 */
function startReviewQuiz() {
    if (!Store.getDueIncorrect().length) return;   // the button is disabled anyway

    switchView('quiz');           // this resets the config card, so it goes first
    quizRange = 'review';
    setQuizType('choice');
    document.getElementById('quiz-config').style.display = 'none';
    startQuiz();
}

/** Badge + enabled state for the dashboard's 오늘 복습 button. */
function updateReviewEntry() {
    const btn = document.getElementById('review-entry');
    if (!btn) return;

    const due = Store.getDueIncorrect().length;
    const limit = getReviewLimit();
    const badge = document.getElementById('review-badge');
    const sub = document.getElementById('review-entry-sub');

    // Show the whole backlog, but say how much of it today's run covers, so a
    // capped session never looks like the queue is empty.
    badge.textContent = due > limit ? `${limit} / ${due}` : String(due);
    btn.disabled = due === 0;

    if (due === 0) {
        sub.textContent = '복습할 단어가 없습니다';
    } else if (due > limit) {
        sub.textContent = `만기 ${due}개 중 ${limit}개를 4지선다로 출제합니다 (많이 틀린 단어 우선)`;
    } else {
        sub.textContent = `${due}개를 4지선다로 출제합니다`;
    }
}

function renderQuizQuestion() {
    const questionNumEl = document.getElementById('quiz-question-number');
    const scoreDisplayEl = document.getElementById('quiz-score-display');
    const progressBar = document.getElementById('quiz-progress-bar');
    const questionText = document.getElementById('quiz-question-text');
    const quizCat = document.getElementById('quiz-card-category');
    const ttsBtn = document.getElementById('quiz-tts-btn');
    const optionsGrid = document.getElementById('quiz-options-container');
    const inputContainer = document.getElementById('quiz-input-container');
    const typingInput = document.getElementById('quiz-typing-input');
    const feedbackPanel = document.getElementById('quiz-feedback');
    const quizCard = document.querySelector('.quiz-card');
    const choiceSubmitBtn = document.getElementById('quiz-choice-submit-btn');
    
    // Reset classes and feedback panel
    feedbackPanel.style.display = 'none';
    quizCard.classList.remove('shake');
    
    // Update progress elements
    questionNumEl.textContent = `문제 ${quizIndex + 1}/${quizWords.length}`;
    
    // Calculate score dynamically
    const correctCount = quizWords.filter(w => w.isCorrect).length;
    scoreDisplayEl.textContent = `점수: ${correctCount * 10}`;
    progressBar.style.width = `${((quizIndex + 1) / quizWords.length) * 100}%`;
    
    const word = quizWords[quizIndex];
    quizCat.textContent = word.category || selectedCategory;
    
    if (quizDirection === 'eng-to-kor') {
        questionText.textContent = word.english;
        ttsBtn.style.display = 'flex';
    } else {
        // The full gloss, not one meaning of it: with several meanings on screen the
        // answer is pinned to a single word, and the learner has to match the whole profile.
        questionText.textContent = word.korean;
        ttsBtn.style.display = 'none';
    }
    
    if (quizType === 'choice') {
        optionsGrid.style.display = 'grid';
        inputContainer.style.display = 'none';
        choiceSubmitBtn.style.display = 'block';
        
        // Generate options if they don't exist yet
        if (!word.shuffledOptions) {
            word.shuffledOptions = buildChoiceOptions(word);
            word.correctIndex = word.shuffledOptions.findIndex(o => o.english === word.english);
        }
        
        currentQuizOptions = word.shuffledOptions;
        currentQuizCorrectIndex = word.correctIndex;
        
        // Render options grid
        optionsGrid.innerHTML = '';
        currentQuizOptions.forEach((option, idx) => {
            const btn = document.createElement('button');
            btn.className = 'quiz-option';
            
            // Add keyboard shortcut badge and text
            btn.innerHTML = `
                <span class="option-badge">${idx + 1}</span>
                <span class="option-text">${quizDirection === 'eng-to-kor' ? option.korean : option.english}</span>
            `;
            
            if (word.isAnswered) {
                btn.disabled = true;
                if (idx === word.correctIndex) {
                    btn.classList.add('correct');
                } else if (idx === word.selectedOptionIdx) {
                    btn.classList.add('incorrect');
                }
            } else {
                btn.onclick = () => selectChoiceOption(idx);
                if (idx === word.selectedOptionIdx) {
                    btn.classList.add('selected');
                }
            }
            optionsGrid.appendChild(btn);
        });
        
        // Update Submit button status
        if (word.isAnswered) {
            choiceSubmitBtn.style.display = 'none';
            showFeedback(word.isCorrect, word);
        } else {
            selectedOptionIdx = word.selectedOptionIdx;
            if (selectedOptionIdx !== -1) {
                choiceSubmitBtn.disabled = false;
                choiceSubmitBtn.textContent = '선택 완료 (Enter)';
                choiceSubmitBtn.style.background = 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))';
            } else {
                choiceSubmitBtn.disabled = true;
                choiceSubmitBtn.textContent = '번호나 마우스를 통해 답안을 선택하세요';
                choiceSubmitBtn.style.background = 'rgba(255, 255, 255, 0.05)';
            }
        }
    } else {
        optionsGrid.style.display = 'none';
        choiceSubmitBtn.style.display = 'none';
        inputContainer.style.display = 'flex';
        
        const typingSubmitBtn = inputContainer.querySelector('.submit-answer-btn');
        
        if (word.isAnswered) {
            typingInput.value = word.typedAnswer;
            typingInput.disabled = true;
            typingSubmitBtn.disabled = true;
            showFeedback(word.isCorrect, word);
        } else {
            typingInput.value = '';
            typingInput.disabled = false;
            typingSubmitBtn.disabled = false;
            setTimeout(() => typingInput.focus(), 50);
        }
    }
}

function selectChoiceOption(idx) {
    const word = quizWords[quizIndex];
    if (word.isAnswered) return;
    
    word.selectedOptionIdx = idx;
    selectedOptionIdx = idx;
    
    // Highlight the selected option and remove from others
    const options = document.querySelectorAll('.quiz-option');
    options.forEach((opt, i) => {
        if (i === idx) {
            opt.classList.add('selected');
        } else {
            opt.classList.remove('selected');
        }
    });
    
    // Enable submit button
    const choiceSubmitBtn = document.getElementById('quiz-choice-submit-btn');
    if (choiceSubmitBtn) {
        choiceSubmitBtn.disabled = false;
        choiceSubmitBtn.textContent = '선택 완료 (Enter)';
        choiceSubmitBtn.style.background = 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))';
    }
}

function submitChoiceAnswer() {
    const word = quizWords[quizIndex];
    if (word.isAnswered || selectedOptionIdx === -1) return;
    
    word.isAnswered = true;
    const isCorrect = (selectedOptionIdx === currentQuizCorrectIndex);
    word.isCorrect = isCorrect;
    
    // Disable options and show colors
    const options = document.querySelectorAll('.quiz-option');
    options.forEach((opt, idx) => {
        opt.disabled = true;
        opt.classList.remove('selected');
        if (idx === currentQuizCorrectIndex) {
            opt.classList.add('correct');
        } else if (idx === selectedOptionIdx) {
            opt.classList.add('incorrect');
        }
    });
    
    // Hide submit button
    const choiceSubmitBtn = document.getElementById('quiz-choice-submit-btn');
    if (choiceSubmitBtn) {
        choiceSubmitBtn.style.display = 'none';
    }
    
    if (isCorrect) {
        applyCorrectAnswer(word);
        showFeedback(true, word);
    } else {
        document.querySelector('.quiz-card').classList.add('shake');
        saveIncorrectWord(word);
        showFeedback(false, word);
    }
}

function handleQuizInputKey(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (quizType === 'choice') {
            submitChoiceAnswer();
        } else {
            submitTypedAnswer();
        }
    }
}

// Expand a dictionary-style Korean gloss (e.g. "~에 영향을 미치다", "(상품의) 독점, 전매")
// into a set of normalized (whitespace-stripped) answers that should count as correct.
function buildAcceptableKoreanAnswers(koreanText) {
    const stripSpaces = (s) => s.replace(/\s+/g, '');
    const candidates = koreanText
        .split(/[;,\/·]/)
        .map(s => s.trim())
        .filter(Boolean);
    candidates.push(koreanText.trim());

    const results = new Set();
    candidates.forEach(raw => {
        const c = raw.replace(/[（）]/g, m => (m === '（' ? '(' : ')'));

        // as written
        results.add(stripSpaces(c));
        // "~에 " style placeholder + following particle removed entirely
        results.add(stripSpaces(c.replace(/~\S*\s*/g, '')));
        // just the "~" character removed, particle kept
        results.add(stripSpaces(c.replace(/~/g, '')));
        // parenthetical remark dropped entirely: "(상품의) 독점" -> "독점"
        const noParens = c.replace(/\([^)]*\)\s*/g, '').trim();
        if (noParens) results.add(stripSpaces(noParens));
        // parenthetical remark kept but unwrapped: "(상품의) 독점" -> "상품의 독점"
        const flatParens = c.replace(/[()]/g, '').trim();
        if (flatParens) results.add(stripSpaces(flatParens));
    });

    return results;
}

function submitTypedAnswer() {
    const inputField = document.getElementById('quiz-typing-input');
    const answer = inputField.value.trim().toLowerCase();
    
    if (!answer) return;
    
    inputField.disabled = true;
    inputField.blur(); // Blur the field so keydown focus shifts to document body
    const correctWord = quizWords[quizIndex];
    
    correctWord.isAnswered = true;
    correctWord.typedAnswer = inputField.value;
    
    let isCorrect = false;
    if (quizDirection === 'eng-to-kor') {
        const cleanAnswer = answer.replace(/\s+/g, '');
        const acceptableAnswers = buildAcceptableKoreanAnswers(correctWord.korean);
        isCorrect = acceptableAnswers.has(cleanAnswer);
    } else {
        isCorrect = (answer === correctWord.english.toLowerCase());
    }
    
    correctWord.isCorrect = isCorrect;
    
    const typingSubmitBtn = document.querySelector('#quiz-input-container .submit-answer-btn');
    if (typingSubmitBtn) {
        typingSubmitBtn.disabled = true;
    }
    
    if (isCorrect) {
        applyCorrectAnswer(correctWord);
        showFeedback(true, correctWord);
    } else {
        document.querySelector('.quiz-card').classList.add('shake');
        saveIncorrectWord(correctWord);
        showFeedback(false, correctWord);
    }
}

function showFeedback(isCorrect, word) {
    const feedbackPanel = document.getElementById('quiz-feedback');
    const titleEl = document.getElementById('feedback-title');
    const subtextEl = document.getElementById('feedback-subtext');
    const iconEl = document.getElementById('feedback-icon');
    
    feedbackPanel.style.display = 'flex';

    const overrideBtn = document.getElementById('quiz-override-correct-btn');

    if (isCorrect) {
        iconEl.textContent = '🎉';
        titleEl.textContent = '정답입니다!';
        titleEl.style.color = 'var(--accent-green)';

        if (word.graduated) titleEl.textContent = '정답입니다! 오답노트 졸업 🎓';

        if (overrideBtn) overrideBtn.style.display = 'none';
    } else {
        iconEl.textContent = '❌';
        titleEl.textContent = '틀렸습니다!';
        titleEl.style.color = 'var(--accent-secondary)';

        // Remove from mastered words since they got it wrong
        if (masteredWords.has(word.english)) {
            masteredWords.delete(word.english);
            Store.setMastered(word.english, false);
        }

        // Rigid string matching can't cover every valid synonym/phrasing for the
        // Korean meaning, so let the user self-grade eng->kor write answers.
        if (overrideBtn) {
            const canOverride = (quizType === 'write' && quizDirection === 'eng-to-kor');
            overrideBtn.style.display = canOverride ? 'inline-block' : 'none';
        }
    }

    subtextEl.innerHTML = `<strong>${word.english}</strong> : ${word.korean}`
        + (word.reviewNotice ? `<span class="feedback-review-note">${word.reviewNotice}</span>` : '');
    
    // Toggle prev/next buttons
    const prevBtn = document.getElementById('quiz-prev-btn');
    const nextBtn = document.getElementById('quiz-next-btn');
    
    if (prevBtn) {
        prevBtn.style.display = quizIndex > 0 ? 'block' : 'none';
    }
    
    if (nextBtn) {
        if (quizIndex === quizWords.length - 1) {
            nextBtn.textContent = '결과 보기';
        } else {
            nextBtn.textContent = '다음 문제';
        }
    }

    // On a phone the four options fill the screen, leaving this panel — and the
    // '다음 문제' button — below the fold right when the user needs it.
    if (isPhoneLayout()) {
        requestAnimationFrame(() => {
            feedbackPanel.scrollIntoView({ behavior: 'smooth', block: 'end' });
        });
    }
}

// Let the user flip a rigid-match "틀렸습니다" to correct when they judge their
// typed Korean meaning was actually right (synonym/phrasing the string match missed).
function overrideMarkCorrect() {
    const word = quizWords[quizIndex];
    if (!word || word.isCorrect) return;

    word.isCorrect = true;
    // The strict string match already banked this as a miss, and that stays:
    // wrong_count is monotonic history and run.py merges it with max(), so
    // decrementing here would only be undone by the next sync. Crediting the
    // correct answer is enough — it starts the streak and pushes the review
    // date out, which is what the user is actually asking for.
    word.scored = false;
    applyCorrectAnswer(word);
    showFeedback(true, word);

    const scoreDisplayEl = document.getElementById('quiz-score-display');
    const correctCount = quizWords.filter(w => w.isCorrect).length;
    scoreDisplayEl.textContent = `점수: ${correctCount * 10}`;
}

function speakQuizWord() {
    const word = quizWords[quizIndex];
    if (word) {
        speak(word.english);
    }
}

function prevQuizQuestion() {
    if (quizIndex > 0) {
        quizIndex--;
        renderQuizQuestion();
    }
}

function nextQuizQuestion() {
    if (!quizWords[quizIndex].isAnswered) return;
    
    quizIndex++;
    if (quizIndex < quizWords.length) {
        renderQuizQuestion();
    } else {
        showQuizResults();
    }
}

function showQuizResults() {
    document.getElementById('quiz-screen').style.display = 'none';
    const resultsContainer = document.getElementById('quiz-results');
    resultsContainer.style.display = 'block';
    
    const correctCount = quizWords.filter(w => w.isCorrect).length;
    const incorrectCount = quizWords.length - correctCount;
    const percent = Math.round((correctCount / quizWords.length) * 100);
    
    document.getElementById('results-score-percent').textContent = `${percent}%`;
    document.getElementById('results-score-fraction').textContent = `${correctCount}/${quizWords.length}`;
    document.getElementById('results-correct-count').textContent = correctCount;
    document.getElementById('results-incorrect-count').textContent = incorrectCount;
}

function restartQuizSetup() {
    // 'review' is only ever entered from the dashboard button; the config card
    // has no chip for it, so returning here has to fall back to a real range.
    if (quizRange === 'review') quizRange = 'all';
    document.getElementById('quiz-config').style.display = 'block';
    document.getElementById('quiz-screen').style.display = 'none';
    document.getElementById('quiz-results').style.display = 'none';
    updateQuizConfigUI();
}

/**
 * Bank a correct answer. Called once, from the submit paths — never from
 * showFeedback, which re-runs every time the user navigates back onto an
 * answered question and would otherwise graduate a word on a streak of one.
 *
 * A word in the 오답노트 does not leave on a single right answer: on a 4-choice
 * question that is a 25% guess. It takes two in a row (Store.GRADUATE_STREAK),
 * and in between its review date is pushed a week out. Words that were never
 * missed keep the original behaviour — one correct answer marks them mastered.
 */
function applyCorrectAnswer(word) {
    if (word.scored) return;   // idempotent: 정답 처리 override can re-enter
    word.scored = true;

    const inIncorrect = db['오답노트'] && db['오답노트'].some(w => w.english === word.english);
    if (!inIncorrect) {
        masteredWords.add(word.english);
        Store.setMastered(word.english, true);
        return;
    }

    const result = Store.recordCorrect(word.english);
    if (result && result.graduated) {
        masteredWords.add(word.english);
        word.graduated = true;
    } else if (result) {
        word.reviewNotice = `연속 정답 ${result.streak}/${Store.GRADUATE_STREAK}회 — ${Store.CORRECT_REVIEW_DAYS}일 뒤 다시 확인합니다`;
    }
    refreshIncorrectViews();
}

// Record a wrong answer locally. No network involved — the Mac finds out on the
// next sync, so quizzing works the same on a plane as it does at the desk.
function saveIncorrectWord(word) {
    Store.recordIncorrect(word, selectedCategory);
    refreshIncorrectViews();
}


// ---------------------------------------------------------------------------
// Sync & settings
// ---------------------------------------------------------------------------

let toastTimer = null;

function showToast(message, kind = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show toast-${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

function formatSyncTime(iso) {
    if (!iso) return '아직 동기화하지 않음';
    const d = new Date(iso);
    if (isNaN(d)) return '아직 동기화하지 않음';

    const minutes = Math.floor((Date.now() - d.getTime()) / 60000);
    if (minutes < 1) return '방금 동기화됨';
    if (minutes < 60) return `${minutes}분 전 동기화됨`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전 동기화됨`;
    return `${d.toLocaleDateString('ko-KR')} 동기화됨`;
}

function updateSyncStatus(state) {
    const last = Store.getLastSync();
    const text = state === 'syncing' ? '동기화 중...' : formatSyncTime(last);

    const statusText = document.getElementById('sync-status-text');
    if (statusText) statusText.textContent = text;

    const indicator = document.getElementById('sync-indicator');
    if (indicator) {
        indicator.className = 'status-indicator';
        if (state === 'syncing') indicator.classList.add('syncing');
        else if (state === 'error') indicator.classList.add('error');
        else if (last) indicator.classList.add('online');
    }

    const modalStatus = document.getElementById('modal-sync-status');
    if (modalStatus) modalStatus.textContent = `${text} · 서버 ${Store.getServerUrl()}`;
}

/**
 * @param {boolean} silent  Suppress toasts. Used for the opportunistic sync on
 *   launch, where the Mac being off is the normal case, not an error worth
 *   interrupting the user over.
 */
async function syncNow(silent = false) {
    const buttons = [document.getElementById('btn-sync'), document.getElementById('btn-sync-mobile')]
        .filter(Boolean);
    buttons.forEach(b => { b.disabled = true; b.classList.add('is-syncing'); });
    updateSyncStatus('syncing');

    try {
        const data = await Store.sync();
        applyWords(Store.getWords() || {});
        masteredWords = Store.getMasteredSet();
        updateDashboard();
        updateSyncStatus('ok');
        if (!silent) {
            showToast(`동기화 완료 · 단어 ${Object.keys(data.words || {}).length}일차, 오답 ${Store.getIncorrect().length}개`, 'success');
        }
    } catch (e) {
        console.error('Sync failed:', e);
        updateSyncStatus('error');
        if (!silent) {
            showToast(`동기화 실패: ${e.message}. Mac에서 run.py가 실행 중인지, 같은 Wi-Fi인지 확인하세요.`, 'error');
        }
    } finally {
        buttons.forEach(b => { b.disabled = false; b.classList.remove('is-syncing'); });
        updateLocalStats();
    }
}

async function exportIncorrectToExcel() {
    const btn = document.getElementById('btn-export-excel');
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '백업 중...'; }

    try {
        // Push first, so the sheet reflects anything recorded on this device.
        await Store.sync();
        await Store.exportToExcel();
        updateSyncStatus('ok');
        showToast('엑셀 오답노트 시트에 백업했습니다.', 'success');
    } catch (e) {
        console.error('Excel export failed:', e);
        showToast(`백업 실패: ${e.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }
}

function updateLocalStats() {
    const el = document.getElementById('modal-local-stats');
    if (!el) return;
    el.textContent = `오답노트 ${Store.getIncorrect().length}개 · 완료한 단어 ${Store.getMasteredSet().size}개 (이 기기에 저장됨)`;
}

function openSettings() {
    document.getElementById('server-url-input').value = Store.getServerUrl();
    document.getElementById('review-limit-input').value = getReviewLimit();
    updateSyncStatus();
    updateLocalStats();
    document.getElementById('settings-overlay').classList.add('open');
}

function closeSettings() {
    document.getElementById('settings-overlay').classList.remove('open');
}

function onSettingsOverlayClick(event) {
    if (event.target.id === 'settings-overlay') closeSettings();
}

function saveServerUrl() {
    const value = document.getElementById('server-url-input').value.trim();
    if (!/^https?:\/\/.+/i.test(value)) {
        showToast('http:// 또는 https:// 로 시작하는 주소를 입력하세요.', 'error');
        return;
    }
    Store.setServerUrl(value);
    updateSyncStatus();
    showToast('서버 주소를 저장했습니다.', 'success');
}

function saveReviewLimit() {
    const input = document.getElementById('review-limit-input');
    const value = parseInt(input.value, 10);
    if (!value || isNaN(value) || value < 5 || value > 200) {
        showToast('5에서 200 사이의 숫자를 입력하세요.', 'error');
        input.value = getReviewLimit();
        return;
    }
    localStorage.setItem(REVIEW_LIMIT_KEY, String(value));
    input.value = value;
    updateReviewEntry();
    showToast(`하루 복습 문항 수를 ${value}개로 저장했습니다.`, 'success');
}

function resetReviewLimit() {
    localStorage.removeItem(REVIEW_LIMIT_KEY);
    document.getElementById('review-limit-input').value = REVIEW_QUIZ_LIMIT_DEFAULT;
    updateReviewEntry();
    showToast(`하루 복습 문항 수를 기본값(${REVIEW_QUIZ_LIMIT_DEFAULT}개)으로 되돌렸습니다.`, 'success');
}

function resetServerUrl() {
    Store.setServerUrl(Store.DEFAULT_SERVER);
    document.getElementById('server-url-input').value = Store.getServerUrl();
    updateSyncStatus();
    showToast('기본 주소로 되돌렸습니다.', 'success');
}

/* ================= TRACING MODE ================= */
// Every letter the user sees is a slot in #tracing-slots. #tracing-input sits on
// top of them, fully transparent, and exists only to own the caret and to raise
// the phone keyboard — the caret is pinned to the end of the value, so the slot
// row and the input can never disagree about which letter comes next.

const TRACING_MIN_FONT = 18;      // px; nothing below this is worth tracing over
const TRACING_MAX_ROWS = 2;       // a phrase may wrap once, never into a tall stack
const TRACING_CHAR_EM = 0.72;     // .tracing-slot width, kept in step with style.css
const TRACING_SPACE_EM = 0.5;     // .tracing-space width, likewise
const TRACING_ADVANCE_MS = 700;   // pause on the finished word before moving on
const TRACING_REVEAL_MS = 1800;

// Device-local UI preference, deliberately outside Store: which hints this screen
// shows says nothing about study progress and has no business in the sync payload.
const TRACING_HINT_KEY = 'voca_tracing_hints';

function loadTracingHintPref() {
    try {
        return localStorage.getItem(TRACING_HINT_KEY) !== 'off';
    } catch (e) {
        return true;
    }
}

function tracingEl(id) {
    return document.getElementById(id);
}

// The word being traced, in one canonical form. The Excel reaches data.json as NFC
// today, but a decomposed 'e' would otherwise get a slot of its own for the accent.
function tracingTarget() {
    const word = currentWords[tracingIndex];
    return word ? word.english.normalize('NFC') : '';
}

// What counts as the same letter. A phone keyboard swaps a straight apostrophe for
// a curly one by itself (do one's utmost), and reaching an accent is a fight on any
// keyboard (attach a resume) - neither is a spelling mistake worth marking red.
function tracingSameChar(typed, expected) {
    return tracingFoldChar(typed) === tracingFoldChar(expected);
}

function tracingFoldChar(ch) {
    return ch.toLowerCase()
        .replace(/[\u2018\u2019\u02BC]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function updateTracingUI() {
    clearTimeout(tracingAdvanceTimer);
    clearTimeout(tracingRevealTimer);

    const total = currentWords.length;
    const inputEl = tracingEl('tracing-input');
    const trackEl = tracingEl('tracing-track');
    const wasFocused = document.activeElement === inputEl;

    tracingEl('tracing-total').textContent = total;
    tracingEl('tracing-done-total').textContent = total;
    tracingEl('tracing-done').textContent = tracingDone.size;

    inputEl.value = '';
    trackEl.className = 'tracing-track';

    if (total === 0) {
        tracingIndex = 0;
        tracingEl('tracing-empty').style.display = '';
        tracingEl('tracing-body').style.display = 'none';
        tracingEl('tracing-cat').textContent = '-';
        tracingEl('tracing-index').textContent = 0;
        setTracingDisabled(true);
        return;
    }

    tracingEl('tracing-empty').style.display = 'none';
    tracingEl('tracing-body').style.display = '';
    setTracingDisabled(false);

    if (tracingIndex < 0 || tracingIndex >= total) tracingIndex = 0;
    const word = currentWords[tracingIndex];

    tracingEl('tracing-cat').textContent = word.category || selectedCategory;
    tracingEl('tracing-meaning').textContent = word.korean;
    tracingEl('tracing-index').textContent = tracingIndex + 1;

    const target = tracingTarget();
    inputEl.maxLength = target.length;

    applyTracingHintState();
    buildTracingSlots(target);
    renderTracingProgress();
    loadTracingPhonetic(word.english);

    // Never summon the phone keyboard just because the view opened; do keep it up
    // once the user has started typing, or every advance would dismiss it.
    if (!isPhoneLayout() || wasFocused) focusTracingInput();
}

function setTracingDisabled(disabled) {
    ['tracing-input', 'tracing-btn-prev', 'tracing-btn-next', 'tracing-hint-btn', 'tracing-reset-btn']
        .forEach(id => { tracingEl(id).disabled = disabled; });
}

// One slot per character, grouped so that a long phrase wraps between words rather
// than in the middle of a spelling. The space that follows a word goes inside that
// word's group: left on its own it would be the item that starts the next line,
// eating a slot's width off the front of it.
function buildTracingSlots(english) {
    const slotsEl = tracingEl('tracing-slots');
    slotsEl.innerHTML = '';
    slotsEl.style.fontSize = tracingFontSize(english) + 'px';

    const chunks = english.split(' ');
    let charIndex = 0;

    chunks.forEach((chunk, chunkIdx) => {
        const group = document.createElement('span');
        group.className = 'tracing-group';
        for (const ch of chunk) group.appendChild(makeTracingSlot(ch, charIndex++));

        // The space between two words is a character the user still has to type.
        if (chunkIdx < chunks.length - 1) group.appendChild(makeTracingSlot(' ', charIndex++));

        slotsEl.appendChild(group);
    });
}

function makeTracingSlot(ch, index) {
    const slot = document.createElement('span');
    slot.className = ch === ' ' ? 'tracing-slot tracing-space' : 'tracing-slot';
    slot.dataset.index = index;

    const ghost = document.createElement('span');
    ghost.className = 'tracing-ghost';
    ghost.textContent = ch === ' ' ? '' : ch;

    const typed = document.createElement('span');
    typed.className = 'tracing-typed';

    slot.appendChild(ghost);
    slot.appendChild(typed);
    return slot;
}

// The biggest size at which the word still fits the row budget. Sizing to the
// longest word instead would keep the letters large but stack a phrase five rows
// high; the row budget is what keeps the card a card.
function tracingFontSize(english) {
    const track = tracingEl('tracing-track');
    const available = Math.max((track.clientWidth || 560) - 8, 160);
    const maxFont = isPhoneLayout() ? 40 : 48;

    for (let font = maxFont; font > TRACING_MIN_FONT; font--) {
        if (tracingRowCount(english, font, available) <= TRACING_MAX_ROWS) return font;
    }
    return TRACING_MIN_FONT;
}

// Greedy wrap over the same groups buildTracingSlots creates - word plus its
// trailing space - which is exactly how the flex container breaks the row.
// Infinity means one group alone is too wide to fit at this size.
function tracingRowCount(english, font, available) {
    const charWidth = font * TRACING_CHAR_EM;
    const spaceWidth = font * TRACING_SPACE_EM;
    const words = english.split(' ');
    let rows = 1;
    let used = 0;

    for (let i = 0; i < words.length; i++) {
        const width = words[i].length * charWidth + (i < words.length - 1 ? spaceWidth : 0);
        if (width > available) return Infinity;

        if (used > 0 && used + width > available) {
            rows++;
            used = width;
        } else {
            used += width;
        }
    }
    return rows;
}

// Paint the typed letters onto the slots. Returns how the attempt currently stands
// so the callers do not have to re-derive it.
function renderTracingProgress() {
    const target = tracingTarget();
    if (!target) return { complete: false, hasWrong: false };

    const typed = tracingEl('tracing-input').value.normalize('NFC');
    let hasWrong = false;

    tracingEl('tracing-slots').querySelectorAll('.tracing-slot').forEach(slot => {
        const i = Number(slot.dataset.index);
        const expected = target[i];
        const actual = typed[i];
        const typedEl = slot.querySelector('.tracing-typed');

        slot.classList.remove('is-correct', 'is-wrong', 'is-current');

        if (actual === undefined) {
            typedEl.textContent = '';
            if (i === typed.length) slot.classList.add('is-current');
            return;
        }

        const ok = tracingSameChar(actual, expected);
        // Echo the word's own spelling back, so a phone's auto-capital or a missing
        // accent never looks like a mistake while still being counted as correct.
        typedEl.textContent = ok ? (expected === ' ' ? '' : expected) : actual;
        slot.classList.add(ok ? 'is-correct' : 'is-wrong');
        if (!ok) hasWrong = true;
    });

    return { complete: typed.length === target.length && !hasWrong, hasWrong };
}

function handleTracingInput() {
    if (!currentWords.length) return;
    snapTracingCaret();

    const trackEl = tracingEl('tracing-track');
    const state = renderTracingProgress();

    if (state.complete) {
        completeTracingWord();
        return;
    }

    // Backspacing out of a finished word must cancel the pending advance.
    clearTimeout(tracingAdvanceTimer);
    trackEl.classList.remove('is-complete');
}

function completeTracingWord() {
    if (!currentWords.length) return;

    tracingDone.add(tracingIndex);
    tracingEl('tracing-done').textContent = tracingDone.size;
    tracingEl('tracing-track').classList.add('is-complete');

    const finishedAll = tracingDone.size >= currentWords.length;
    clearTimeout(tracingAdvanceTimer);
    tracingAdvanceTimer = setTimeout(() => {
        if (finishedAll) showToast(`${currentWords.length}개 단어를 모두 따라 썼습니다.`, 'success');
        nextTracingWord();
    }, TRACING_ADVANCE_MS);
}

function handleTracingInputKey(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        submitTracingWord();
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        nextTracingWord();
    } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        prevTracingWord();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        resetTracingInput();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        // The caret has to stay at the end - there is no second line to move to.
        event.preventDefault();
    }
}

function submitTracingWord() {
    if (!currentWords.length) return;
    const state = renderTracingProgress();

    if (state.complete) {
        // Enter just skips the pause the auto-advance would have taken.
        clearTimeout(tracingAdvanceTimer);
        nextTracingWord();
        return;
    }

    // Unfinished or misspelled: stay on the word, show the spelling.
    const trackEl = tracingEl('tracing-track');
    trackEl.classList.remove('shake');
    void trackEl.offsetWidth; // restart the animation even on consecutive tries
    trackEl.classList.add('shake');

    revealTracingSpelling();
}

// Force the ghost letters visible for a moment regardless of the hint toggle -
// this is the correction after a failed attempt.
function revealTracingSpelling() {
    const trackEl = tracingEl('tracing-track');
    trackEl.classList.add('is-revealed');
    clearTimeout(tracingRevealTimer);
    tracingRevealTimer = setTimeout(() => trackEl.classList.remove('is-revealed'), TRACING_REVEAL_MS);
}

function resetTracingInput() {
    if (!currentWords.length) return;
    clearTimeout(tracingAdvanceTimer);
    const inputEl = tracingEl('tracing-input');
    inputEl.value = '';
    tracingEl('tracing-track').classList.remove('is-complete');
    renderTracingProgress();
    focusTracingInput();
}

function toggleTracingHint() {
    tracingHints = !tracingHints;
    try {
        localStorage.setItem(TRACING_HINT_KEY, tracingHints ? 'on' : 'off');
    } catch (e) {
        // Private-mode storage failures only cost the preference, not the feature.
    }
    applyTracingHintState();
    focusTracingInput();
}

function applyTracingHintState() {
    tracingEl('tracing-track').classList.toggle('hints-off', !tracingHints);
    const btn = tracingEl('tracing-hint-btn');
    btn.classList.toggle('active', tracingHints);
    btn.textContent = tracingHints ? '철자 힌트 켬' : '철자 힌트 끔';
}

function focusTracingInput() {
    if (!currentWords.length) return;
    const inputEl = tracingEl('tracing-input');
    inputEl.focus();
    snapTracingCaret();
}

// The caret always sits after the last typed letter: the user can only ever add
// or delete at the end, which is what keeps slot i and value[i] the same letter.
function snapTracingCaret() {
    const inputEl = tracingEl('tracing-input');
    const end = inputEl.value.length;
    if (inputEl.selectionStart !== end || inputEl.selectionEnd !== end) {
        inputEl.setSelectionRange(end, end);
    }
}

function onTracingInputFocus() {
    snapTracingCaret();
    tracingEl('tracing-track').classList.add('is-focused');
}

function onTracingInputBlur() {
    tracingEl('tracing-track').classList.remove('is-focused');
}

// Same late-response guard the phonetic lookup needs everywhere: the user can be
// three words further on by the time the dictionary answers.
function loadTracingPhonetic(english) {
    const el = tracingEl('tracing-phonetic');
    el.textContent = '';
    const token = ++tracingPhoneticToken;
    getPhoneticData(english).then(data => {
        if (token === tracingPhoneticToken) el.textContent = data.text || '';
    });
}

function prevTracingWord() {
    if (!currentWords.length) return;
    tracingIndex = (tracingIndex - 1 + currentWords.length) % currentWords.length;
    updateTracingUI();
}

function nextTracingWord() {
    if (!currentWords.length) return;
    tracingIndex = (tracingIndex + 1) % currentWords.length;
    updateTracingUI();
}

function speakTracingWord(event) {
    if (event) event.stopPropagation(); // the whole track is a click target
    const word = currentWords[tracingIndex];
    if (word) speak(word.english);
}

// Slot sizing is measured, so a rotation or a resized window has to re-measure.
let tracingResizeTimer = null;
window.addEventListener('resize', () => {
    if (!views.tracing.classList.contains('active') || !currentWords.length) return;
    clearTimeout(tracingResizeTimer);
    tracingResizeTimer = setTimeout(() => {
        buildTracingSlots(tracingTarget());
        renderTracingProgress();
    }, 150);
});
