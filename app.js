/* ================================================================
   CFA Level 2 Study Platform — Application Logic
   Features: Spaced Repetition (SM-2), Progress Tracking, 
   Daily Challenge, Topic Filtering, Bookmarks
   ================================================================ */

(function () {
  'use strict';

  // ---- PIN Lock ----
  const PIN_HASH = 'ac94d7b8a64205511ab3d7d1837115a90ecfdf355bc68476d77763adbb806129';
  const PIN_SESSION_KEY = 'cfa_pin_ok';

  async function hashPin(pin) {
    const data = new TextEncoder().encode(pin);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Check if already authenticated this session
  if (sessionStorage.getItem(PIN_SESSION_KEY) === '1') {
    document.getElementById('pin-screen').classList.remove('active');
    bootApp();
  } else {
    const pinInput = document.getElementById('pin-input');
    const pinSubmit = document.getElementById('pin-submit');
    const pinError = document.getElementById('pin-error');

    async function tryPin() {
      const pin = pinInput.value.trim();
      if (!pin) return;
      const h = await hashPin(pin);
      if (h === PIN_HASH) {
        sessionStorage.setItem(PIN_SESSION_KEY, '1');
        document.getElementById('pin-screen').classList.remove('active');
        pinError.style.display = 'none';
        bootApp();
      } else {
        pinError.style.display = 'block';
        pinInput.value = '';
        pinInput.focus();
      }
    }

    pinSubmit.addEventListener('click', tryPin);
    pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryPin(); });
    pinInput.focus();
  }

  function bootApp() {

  // ---- State ----
  const APP_KEY = 'cfa_l2_study_v1';
  let questions = [];
  let currentQuestion = null;
  let selectedOption = null;
  let isAnswered = false;
  let activeFilter = null;        // null = all, string = topic name
  let currentScreen = 'dashboard'; // 'dashboard' | 'question' | 'stats'

  // ---- Persistent State (localStorage) ----
  function loadState() {
    try {
      const raw = localStorage.getItem(APP_KEY);
      return raw ? JSON.parse(raw) : getDefaultState();
    } catch {
      return getDefaultState();
    }
  }

  function saveState() {
    localStorage.setItem(APP_KEY, JSON.stringify(state));
  }

  function getDefaultState() {
    return {
      answers: {},          // { questionId: { correct: bool, count: int, lastSeen: timestamp, nextReview: timestamp, interval: days, easeFactor: float } }
      streak: { current: 0, lastDate: null, best: 0 },
      daily: { date: null, completed: 0, questions: [] },
      bookmarks: [],
      totalAnswered: 0,
      totalCorrect: 0,
      firstUse: Date.now()
    };
  }

  let state = loadState();

  // ---- Data Loading ----
  async function loadQuestions() {
    try {
      const resp = await fetch('data/questions.json');
      const data = await resp.json();
      questions = data.questions;
      console.log(`Loaded ${questions.length} questions across ${data.metadata.topics.length} topics`);
      return true;
    } catch (e) {
      console.error('Failed to load questions:', e);
      return false;
    }
  }

  // ---- SM-2 Spaced Repetition ----
  function getReviewData(qId) {
    return state.answers[qId] || {
      correct: null,
      count: 0,
      lastSeen: 0,
      nextReview: 0,
      interval: 1,
      easeFactor: 2.5
    };
  }

  function updateReview(qId, wasCorrect) {
    const review = getReviewData(qId);
    review.count++;
    review.lastSeen = Date.now();
    review.correct = wasCorrect;

    if (wasCorrect) {
      if (review.count === 1) {
        review.interval = 1;
      } else if (review.count === 2) {
        review.interval = 3;
      } else {
        review.interval = Math.round(review.interval * review.easeFactor);
      }
      review.easeFactor = Math.max(1.3, review.easeFactor + 0.1);
    } else {
      review.interval = 1;
      review.easeFactor = Math.max(1.3, review.easeFactor - 0.3);
    }

    review.nextReview = Date.now() + review.interval * 24 * 60 * 60 * 1000;
    state.answers[qId] = review;
  }

  // ---- Question Selection ----
  function getFilteredQuestions() {
    if (!activeFilter) return questions;
    return questions.filter(q => q.topic === activeFilter);
  }

  function selectNextQuestion() {
    const pool = getFilteredQuestions();
    if (!pool.length) return null;

    const now = Date.now();

    // Priority 1: Questions due for review (spaced repetition)
    const dueForReview = pool.filter(q => {
      const r = state.answers[q.id];
      return r && r.nextReview <= now;
    });

    // Priority 2: Never-seen questions
    const neverSeen = pool.filter(q => !state.answers[q.id]);

    // Priority 3: All questions (with weight towards due/unseen)
    let candidates;
    if (dueForReview.length > 0 && Math.random() < 0.5) {
      candidates = dueForReview;
    } else if (neverSeen.length > 0 && Math.random() < 0.7) {
      candidates = neverSeen;
    } else {
      candidates = pool;
    }

    // Avoid repeating the current question
    if (currentQuestion && candidates.length > 1) {
      candidates = candidates.filter(q => q.id !== currentQuestion.id);
    }

    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ---- Streak Management ----
  function updateStreak() {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    if (state.streak.lastDate === today) return;

    if (state.streak.lastDate === yesterday) {
      state.streak.current++;
    } else if (state.streak.lastDate !== today) {
      state.streak.current = 1;
    }

    state.streak.lastDate = today;
    state.streak.best = Math.max(state.streak.best, state.streak.current);
    saveState();
  }

  // ---- Daily Challenge ----
  function getDailyChallenge() {
    const today = new Date().toISOString().split('T')[0];

    if (state.daily.date !== today) {
      // Reset daily challenge
      const shuffled = [...questions].sort(() => Math.random() - 0.5);
      state.daily = {
        date: today,
        completed: 0,
        questions: shuffled.slice(0, 10).map(q => q.id)
      };
      saveState();
    }

    return state.daily;
  }

  // ---- Statistics ----
  function getTopicStats() {
    const topics = {};
    for (const q of questions) {
      const t = q.topic || 'Unknown';
      if (!topics[t]) {
        topics[t] = { total: 0, answered: 0, correct: 0 };
      }
      topics[t].total++;

      const r = state.answers[q.id];
      if (r) {
        topics[t].answered++;
        if (r.correct) topics[t].correct++;
      }
    }
    return topics;
  }

  function getOverallStats() {
    const answered = Object.keys(state.answers).length;
    const correct = Object.values(state.answers).filter(r => r.correct).length;
    return {
      totalQuestions: questions.length,
      answered,
      correct,
      accuracy: answered > 0 ? Math.round((correct / answered) * 100) : 0,
      coverage: questions.length > 0 ? Math.round((answered / questions.length) * 100) : 0
    };
  }

  // ---- Confetti Effect ----
  function showConfetti() {
    const container = document.createElement('div');
    container.className = 'confetti-container';
    document.body.appendChild(container);

    const colors = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#fbbf24'];
    for (let i = 0; i < 40; i++) {
      const confetti = document.createElement('div');
      confetti.className = 'confetti';
      confetti.style.left = Math.random() * 100 + '%';
      confetti.style.top = -10 + 'px';
      confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
      confetti.style.animationDelay = Math.random() * 0.5 + 's';
      confetti.style.animationDuration = 1.5 + Math.random() * 1 + 's';
      container.appendChild(confetti);
    }

    setTimeout(() => container.remove(), 3000);
  }

  // ---- Toast ----
  function showToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  // ---- Rendering ----

  function renderDashboard() {
    const stats = getOverallStats();
    const topicStats = getTopicStats();
    const daily = getDailyChallenge();
    const streak = state.streak;

    // Check if streak is still active
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const streakActive = streak.lastDate === today || streak.lastDate === yesterday;
    const displayStreak = streakActive ? streak.current : 0;

    // Readiness score (weighted average of topic accuracies)
    const topics = Object.entries(topicStats);
    let readiness = 0;
    if (topics.length > 0) {
      const weights = topics.map(([_, s]) => s.answered);
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      if (totalWeight > 0) {
        readiness = Math.round(
          topics.reduce((acc, [_, s], i) => {
            const accuracy = s.answered > 0 ? s.correct / s.answered : 0;
            return acc + accuracy * (weights[i] / totalWeight);
          }, 0) * 100
        );
      }
    }

    const circumference = 2 * Math.PI * 38;
    const dashOffset = circumference - (readiness / 100) * circumference;

    // Streak dots (last 7 days)
    const streakDots = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
      const isActive = streak.lastDate && new Date(streak.lastDate) >= new Date(d) && displayStreak > 0;
      // Simplified: show dots for the current streak length
      streakDots.push(i < displayStreak);
    }

    const sortedTopics = topics.sort((a, b) => {
      const aAcc = a[1].answered > 0 ? a[1].correct / a[1].answered : -1;
      const bAcc = b[1].answered > 0 ? b[1].correct / b[1].answered : -1;
      return aAcc - bAcc; // Weakest first
    });

    document.getElementById('dashboard-screen').innerHTML = `
      <!-- Header -->
      <div class="app-header">
        <div class="app-logo">CFA Institute</div>
        <h1 class="app-title">Level II Prep</h1>
        <p class="app-subtitle">${questions.length} questions · ${topics.length} topics</p>
      </div>

      <!-- Readiness + Stats -->
      <div class="glass-card dashboard-grid" style="margin-bottom: 16px">
        <div class="readiness-container">
          <div class="readiness-ring">
            <svg width="100" height="100" viewBox="0 0 100 100">
              <circle class="ring-bg" cx="50" cy="50" r="38" fill="none" stroke-width="6" />
              <circle class="ring-fill" cx="50" cy="50" r="38" fill="none" stroke-width="6"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${dashOffset}" />
            </svg>
            <span class="readiness-percent">${readiness}%</span>
          </div>
          <div class="readiness-info">
            <h3>Exam Readiness</h3>
            <p>${stats.answered === 0 ? 'Start practicing to see your readiness score' : `${stats.coverage}% coverage · ${stats.accuracy}% accuracy`}</p>
          </div>
        </div>
      </div>

      <!-- Stats Row -->
      <div class="stats-row" style="margin-bottom: 16px">
        <div class="stat-card">
          <div class="stat-value">${stats.answered}</div>
          <div class="stat-label">Answered</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.accuracy}%</div>
          <div class="stat-label">Accuracy</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${displayStreak}</div>
          <div class="stat-label">Day Streak</div>
        </div>
      </div>

      <!-- Daily Challenge -->
      <div class="daily-challenge" id="daily-challenge-btn">
        <span class="daily-icon">⚡</span>
        <div class="daily-info">
          <div class="daily-title">Daily Challenge</div>
          <div class="daily-desc">10 random questions · Quick practice</div>
        </div>
        <div class="daily-progress">${daily.completed}/10</div>
      </div>

      <!-- Action Buttons -->
      <div class="action-buttons" style="margin-bottom: 16px">
        <button class="btn btn-primary" id="random-question-btn">
          <span class="btn-icon">🎲</span> Random Question
        </button>
        <button class="btn btn-secondary" id="stats-btn">
          <span class="btn-icon">📊</span> Statistics
        </button>
      </div>

      <!-- Streak -->
      <div class="streak-bar" style="margin-bottom: 24px">
        <span class="streak-icon">🔥</span>
        <div class="streak-text">
          <div class="streak-count">${displayStreak} day${displayStreak !== 1 ? 's' : ''}</div>
          <div class="streak-label">Best: ${streak.best} days</div>
        </div>
        <div class="streak-days">
          ${streakDots.map(active => `<div class="streak-dot ${active ? 'active' : ''}"></div>`).join('')}
        </div>
      </div>

      <!-- Topic Progress -->
      <div class="topic-section">
        <div class="section-title">Topics</div>
        <div class="topic-list">
          ${sortedTopics.map(([name, s]) => {
            const pct = s.answered > 0 ? Math.round((s.correct / s.answered) * 100) : 0;
            const barWidth = s.answered > 0 ? pct : 0;
            return `
              <div class="topic-item" data-topic="${name}">
                <div class="topic-name">${name}</div>
                <div class="topic-progress">
                  <span class="topic-count">${s.answered}/${s.total}</span>
                  <div class="topic-bar">
                    <div class="topic-bar-fill" style="width: ${barWidth}%"></div>
                  </div>
                  <span class="topic-percent">${s.answered > 0 ? pct + '%' : '—'}</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    // Event listeners
    document.getElementById('random-question-btn').addEventListener('click', () => {
      activeFilter = null;
      startQuestion();
    });

    document.getElementById('stats-btn').addEventListener('click', () => showStats());

    document.getElementById('daily-challenge-btn').addEventListener('click', () => {
      activeFilter = null;
      const daily = getDailyChallenge();
      if (daily.completed >= 10) {
        showToast('Daily challenge completed! 🎉');
        return;
      }
      // Pick next daily question
      const qId = daily.questions[daily.completed];
      const q = questions.find(q => q.id === qId);
      if (q) {
        currentQuestion = q;
        showQuestionScreen();
      }
    });

    // Topic click handlers
    document.querySelectorAll('.topic-item').forEach(el => {
      el.addEventListener('click', () => {
        activeFilter = el.dataset.topic;
        startQuestion();
      });
    });
  }

  function showQuestionScreen() {
    if (!currentQuestion) return;

    currentScreen = 'question';
    selectedOption = null;
    isAnswered = false;

    document.getElementById('dashboard-screen').classList.remove('active');
    document.getElementById('stats-screen').classList.remove('active');
    document.getElementById('question-screen').classList.add('active');

    renderQuestion();
  }

  function renderQuestion() {
    const q = currentQuestion;
    if (!q) return;

    const isBookmarked = state.bookmarks.includes(q.id);
    // Use full vignette with formatted tables
    const contextText = q.context || q.vignette || '';
    const hasContext = contextText.trim().length > 20;
    const options = Object.entries(q.options);

    let html = `
      <div class="question-screen">
        <!-- Header -->
        <div class="question-header">
          <button class="question-back" id="back-btn">
            ← Back
          </button>
          <div class="question-meta">
            ${q.topic ? `<span class="question-topic-badge">${q.topic}</span>` : ''}
            <span class="question-source">${q.source}</span>
          </div>
          <button class="question-bookmark ${isBookmarked ? 'active' : ''}" id="bookmark-btn" title="Bookmark">
            ${isBookmarked ? '★' : '☆'}
          </button>
        </div>
    `;

    // Context: prefer vignette screenshots, fall back to parsed text
    const hasVignetteImages = q.vignetteImages && q.vignetteImages.length > 0;

    if (hasVignetteImages) {
      // Show full vignette as PDF screenshots — 100% accurate
      const imagesHtml = q.vignetteImages.map(path => 
        `<div class="exhibit-image"><img src="${path}" alt="Context" loading="lazy"></div>`
      ).join('');
      
      html += `
        <div class="context-block">
          <div class="context-label">📋 CONTEXT</div>
          ${imagesHtml}
        </div>
      `;
    } else if (hasContext) {
      // Fallback: parsed text for flashcards/generated questions
      html += `
        <div class="context-block">
          <div class="context-label">📋 CONTEXT</div>
          <div class="context-text">${renderContext(contextText)}</div>
        </div>
      `;
    }

    // Question text
    html += `<div class="question-text">${escapeHtml(q.question)}</div>`;

    // Options
    html += `<div class="options-list" id="options-list">`;
    for (const [letter, text] of options) {
      html += `
        <button class="option-btn" data-letter="${letter}" id="option-${letter}">
          <span class="option-letter">${letter}</span>
          <span class="option-text">${escapeHtml(text)}</span>
          <span class="option-icon"></span>
        </button>
      `;
    }
    html += `</div>`;

    // Submit button
    html += `
      <div class="submit-container">
        <button class="btn btn-primary btn-submit" id="submit-btn" disabled>
          Check Answer
        </button>
      </div>
    `;

    // Explanation placeholder
    html += `<div id="explanation-container"></div>`;

    // Next button placeholder
    html += `<div id="next-container"></div>`;

    html += `</div>`;

    document.getElementById('question-screen').innerHTML = html;

    // Event: Back
    document.getElementById('back-btn').addEventListener('click', showDashboard);

    // Event: Bookmark
    document.getElementById('bookmark-btn').addEventListener('click', () => {
      const idx = state.bookmarks.indexOf(q.id);
      if (idx >= 0) {
        state.bookmarks.splice(idx, 1);
        showToast('Bookmark removed');
      } else {
        state.bookmarks.push(q.id);
        showToast('Bookmarked! ★');
      }
      saveState();
      document.getElementById('bookmark-btn').classList.toggle('active');
      document.getElementById('bookmark-btn').textContent = state.bookmarks.includes(q.id) ? '★' : '☆';
    });

    // Event: Option selection
    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (isAnswered) return;

        // Deselect previous
        document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));

        // Select this
        btn.classList.add('selected');
        selectedOption = btn.dataset.letter;
        document.getElementById('submit-btn').disabled = false;
      });
    });

    // Event: Submit
    document.getElementById('submit-btn').addEventListener('click', submitAnswer);
  }

  function submitAnswer() {
    if (!selectedOption || isAnswered) return;
    isAnswered = true;

    const q = currentQuestion;
    const isCorrect = selectedOption === q.correctAnswer;

    // Update state
    updateReview(q.id, isCorrect);
    state.totalAnswered++;
    if (isCorrect) state.totalCorrect++;

    // Update daily challenge
    const daily = getDailyChallenge();
    if (daily.questions.includes(q.id)) {
      daily.completed = Math.min(daily.completed + 1, 10);
    }

    // Update streak
    updateStreak();
    saveState();

    // Disable all options
    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.classList.add('disabled');
      const letter = btn.dataset.letter;

      if (letter === q.correctAnswer) {
        btn.classList.add('correct');
        btn.querySelector('.option-icon').textContent = '✓';
      } else if (letter === selectedOption && !isCorrect) {
        btn.classList.add('incorrect');
        btn.querySelector('.option-icon').textContent = '✗';
      }
    });

    // Hide submit button
    document.getElementById('submit-btn').style.display = 'none';

    // Show effects
    if (isCorrect) {
      showConfetti();
    } else {
      document.querySelector('.options-list').classList.add('shake');
    }

    // Show explanation
    const explContainer = document.getElementById('explanation-container');
    explContainer.innerHTML = `
      <div class="explanation-card">
        <div class="explanation-header ${isCorrect ? 'correct' : 'incorrect'}">
          <span>${isCorrect ? '✓ Correct!' : '✗ Incorrect'}</span>
          ${!isCorrect ? `<span style="margin-left: auto; font-weight: 400; font-size: 0.8rem">Correct: ${q.correctAnswer}</span>` : ''}
        </div>
        <div class="explanation-body">
          <div class="explanation-text">${escapeHtml(q.explanation)}</div>
          ${q.module || q.los ? `<span class="explanation-module">${[q.module, q.los].filter(Boolean).join(' · ')}</span>` : ''}
        </div>
      </div>
    `;

    // Show next button
    const nextContainer = document.getElementById('next-container');
    nextContainer.innerHTML = `
      <div class="next-container">
        <button class="btn btn-primary btn-next" id="next-btn">
          Next Question →
        </button>
        <button class="btn btn-secondary" id="back-dashboard-btn" style="width: auto; padding: 16px 20px">
          ←
        </button>
      </div>
    `;

    document.getElementById('next-btn').addEventListener('click', () => startQuestion());
    document.getElementById('back-dashboard-btn').addEventListener('click', showDashboard);
  }

  function startQuestion() {
    const q = selectNextQuestion();
    if (!q) {
      showToast('No questions available for this filter');
      return;
    }
    currentQuestion = q;
    showQuestionScreen();
  }

  function showDashboard() {
    currentScreen = 'dashboard';
    document.getElementById('question-screen').classList.remove('active');
    document.getElementById('stats-screen').classList.remove('active');
    document.getElementById('dashboard-screen').classList.add('active');
    renderDashboard();
  }

  function showStats() {
    currentScreen = 'stats';
    document.getElementById('dashboard-screen').classList.remove('active');
    document.getElementById('question-screen').classList.remove('active');
    document.getElementById('stats-screen').classList.add('active');

    const stats = getOverallStats();
    const topicStats = getTopicStats();

    const sortedTopics = Object.entries(topicStats).sort((a, b) => {
      const aAcc = a[1].answered > 0 ? a[1].correct / a[1].answered : -1;
      const bAcc = b[1].answered > 0 ? b[1].correct / b[1].answered : -1;
      return aAcc - bAcc;
    });

    document.getElementById('stats-screen').innerHTML = `
      <div class="stats-header">
        <button class="question-back" id="stats-back-btn">← Back</button>
        <h2>Statistics</h2>
      </div>

      <div class="stats-row" style="margin-bottom: 24px">
        <div class="stat-card">
          <div class="stat-value">${stats.totalQuestions}</div>
          <div class="stat-label">Total</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.answered}</div>
          <div class="stat-label">Seen</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.accuracy}%</div>
          <div class="stat-label">Accuracy</div>
        </div>
      </div>

      <div class="section-title">Performance by Topic</div>
      <div class="topic-list">
        ${sortedTopics.map(([name, s]) => {
          const pct = s.answered > 0 ? Math.round((s.correct / s.answered) * 100) : 0;
          const scoreClass = pct >= 70 ? 'high' : pct >= 50 ? 'medium' : 'low';
          return `
            <div class="weak-topic-item">
              <div>
                <div class="weak-topic-name">${name}</div>
                <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px">
                  ${s.answered}/${s.total} answered · ${s.correct} correct
                </div>
              </div>
              <span class="weak-topic-score ${s.answered > 0 ? scoreClass : ''}">${s.answered > 0 ? pct + '%' : '—'}</span>
            </div>
          `;
        }).join('')}
      </div>

      ${state.bookmarks.length > 0 ? `
        <div class="section-title" style="margin-top: 24px">Bookmarked (${state.bookmarks.length})</div>
        <button class="btn btn-secondary btn-full" id="practice-bookmarks-btn">
          <span class="btn-icon">★</span> Practice Bookmarked Questions
        </button>
      ` : ''}

      <div style="margin-top: 32px; text-align: center">
        <button class="btn btn-secondary" id="reset-btn" style="font-size: 0.75rem; opacity: 0.5">
          Reset All Progress
        </button>
      </div>
    `;

    document.getElementById('stats-back-btn').addEventListener('click', showDashboard);

    const bookmarkBtn = document.getElementById('practice-bookmarks-btn');
    if (bookmarkBtn) {
      bookmarkBtn.addEventListener('click', () => {
        const bookmarked = questions.filter(q => state.bookmarks.includes(q.id));
        if (bookmarked.length > 0) {
          currentQuestion = bookmarked[Math.floor(Math.random() * bookmarked.length)];
          showQuestionScreen();
        }
      });
    }

    document.getElementById('reset-btn').addEventListener('click', () => {
      if (confirm('This will reset all your progress. Are you sure?')) {
        state = getDefaultState();
        saveState();
        showDashboard();
        showToast('Progress reset');
      }
    });
  }

  // ---- Utility ----
  function renderContext(text) {
    if (!text) return '';
    // Split by markdown table blocks and regular text
    const lines = text.split('\n');
    let html = '';
    let inTable = false;
    let tableRows = [];

    function flushTable() {
      if (tableRows.length < 2) return;
      let thtml = '<table>';
      const headerCells = tableRows[0].split('|').filter(c => c.trim() !== '');
      thtml += '<thead><tr>';
      headerCells.forEach(c => {
        thtml += `<th>${c.trim().replace(/\*\*/g, '')}</th>`;
      });
      thtml += '</tr></thead><tbody>';
      // Skip separator row (index 1)
      for (let i = 2; i < tableRows.length; i++) {
        const cells = tableRows[i].split('|').filter(c => c.trim() !== '');
        thtml += '<tr>';
        cells.forEach(c => {
          thtml += `<td>${c.trim().replace(/\*\*/g, '')}</td>`;
        });
        thtml += '</tr>';
      }
      thtml += '</tbody></table>';
      html += thtml;
      tableRows = [];
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        inTable = true;
        // Skip separator rows like |---|---|---|
        if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
          tableRows.push(trimmed); // keep for counting
          continue;
        }
        tableRows.push(trimmed);
      } else {
        if (inTable) {
          flushTable();
          inTable = false;
        }
        // Skip <br/> tags
        if (trimmed === '<br/>' || trimmed === '<br>') continue;
        // Bold text
        if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
          html += `<strong>${escapeHtml(trimmed.replace(/\*\*/g, ''))}</strong><br>`;
        } else if (trimmed === '') {
          html += '<br>';
        } else {
          html += escapeHtml(trimmed) + '<br>';
        }
      }
    }
    if (inTable) flushTable();
    // Clean up excessive <br> tags
    html = html.replace(/(<br>){3,}/g, '<br><br>');
    return html;
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ---- Keyboard Shortcuts ----
  document.addEventListener('keydown', (e) => {
    if (currentScreen !== 'question') return;

    if (!isAnswered) {
      if (['a', 'A', '1'].includes(e.key)) {
        const btn = document.getElementById('option-A');
        if (btn) btn.click();
      } else if (['b', 'B', '2'].includes(e.key)) {
        const btn = document.getElementById('option-B');
        if (btn) btn.click();
      } else if (['c', 'C', '3'].includes(e.key)) {
        const btn = document.getElementById('option-C');
        if (btn) btn.click();
      } else if (e.key === 'Enter') {
        const submit = document.getElementById('submit-btn');
        if (submit && !submit.disabled) submit.click();
      }
    } else {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = document.getElementById('next-btn');
        if (next) next.click();
      }
    }
  });

  // ---- Init ----
  async function init() {
    const loaded = await loadQuestions();
    if (!loaded) {
      document.getElementById('dashboard-screen').innerHTML = `
        <div class="empty-state">
          <div class="emoji">😵</div>
          <h3>Failed to load questions</h3>
          <p>Make sure data/questions.json exists</p>
        </div>
      `;
      return;
    }

    document.getElementById('dashboard-screen').classList.add('active');
    renderDashboard();
  }

  // Start
  init();

  } // end bootApp
})();
