(() => {
  const categorySelect = document.getElementById("category-select");
  const modeSelect = document.getElementById("mode-select");
  const categoryStats = document.getElementById("category-stats");
  const emptyState = document.getElementById("empty-state");
  const roundComplete = document.getElementById("round-complete");
  const roundCompleteMessage = document.getElementById("round-complete-message");
  const repeatSetBtn = document.getElementById("repeat-set-btn");
  const chooseCategoryBtn = document.getElementById("choose-category-btn");
  const cardArea = document.getElementById("card-area");
  const roundProgress = document.getElementById("round-progress");
  const reviewBadge = document.getElementById("review-badge");
  const cardEl = document.getElementById("card");
  const frontText = document.getElementById("front-text");
  const backText = document.getElementById("back-text");
  const answerButtons = document.getElementById("answer-buttons");
  const btnRight = document.getElementById("btn-right");
  const btnWrong = document.getElementById("btn-wrong");
  const reviewAllBtn = document.getElementById("review-all-btn");
  const toastEl = document.getElementById("toast");
  const hintText = document.getElementById("hint-text");
  const tabStudy = document.getElementById("tab-study");
  const tabDashboard = document.getElementById("tab-dashboard");
  const studyView = document.getElementById("study-view");
  const dashboardView = document.getElementById("dashboard-view");
  const dashboardGroups = document.getElementById("dashboard-groups");
  const wordHintBtn = document.getElementById("word-hint-btn");
  const wordHintPanel = document.getElementById("word-hint-panel");
  const streakDots = document.getElementById("streak-dots");
  const reviewStatus = document.getElementById("review-status");
  const reviewAllToggle = document.getElementById("review-all-toggle");
  const dueBadge = document.getElementById("due-badge");
  const dueSummaryEl = document.getElementById("due-summary");

  // Mastery Quiz
  const tabQuiz = document.getElementById("tab-quiz");
  const quizView = document.getElementById("quiz-view");
  const quizIntro = document.getElementById("quiz-intro");
  const quizLastLine = document.getElementById("quiz-last-line");
  const quizStartBtn = document.getElementById("quiz-start-btn");
  const quizLookalikeBtn = document.getElementById("quiz-lookalike-btn");
  const quizLookalikeLastLine = document.getElementById("quiz-lookalike-last-line");
  const quizConjugationBtn = document.getElementById("quiz-conjugation-btn");
  const quizConjugationLastLine = document.getElementById("quiz-conjugation-last-line");
  const quizCardArea = document.getElementById("quiz-card-area");
  const quizProgress = document.getElementById("quiz-progress");
  const quizDirectionLabel = document.getElementById("quiz-direction-label");
  const quizCardEl = document.getElementById("quiz-card");
  const quizFrontText = document.getElementById("quiz-front-text");
  const quizBackText = document.getElementById("quiz-back-text");
  const quizHintText = document.getElementById("quiz-hint-text");
  const quizAnswerButtons = document.getElementById("quiz-answer-buttons");
  const quizBtnRight = document.getElementById("quiz-btn-right");
  const quizBtnWrong = document.getElementById("quiz-btn-wrong");
  const quizResult = document.getElementById("quiz-result");
  const quizResultPercent = document.getElementById("quiz-result-percent");
  const quizResultDetail = document.getElementById("quiz-result-detail");
  const quizSavedNote = document.getElementById("quiz-saved-note");
  const quizAgainBtn = document.getElementById("quiz-again-btn");
  const quizToDashboardBtn = document.getElementById("quiz-to-dashboard-btn");
  const quizTrackerEl = document.getElementById("quiz-tracker");

  let currentCategoryId = null;
  let currentMode = "fi-en"; // "fi-en" = show Finnish, translate to English
  let currentCategoryData = null; // full payload from /api/category/:id
  let roundQueue = []; // shuffled cards left to see this pass, no repeats
  let roundSize = 0; // how many cards this pass started with
  let currentCard = null;
  let isFlipped = false;
  let forceReviewAll = false;
  let toastTimer = null;

  // Mastery Quiz state. quizDeck is non-empty only while a quiz is in
  // progress; quizStatus is the latest /api/quiz/status (null if unavailable).
  let quizStatus = null;
  let quizDeck = [];
  let quizMode = "mastery"; // which kind of quiz quizDeck belongs to
  let quizIndex = 0;
  let quizCorrect = 0;
  // One {category, id, direction, correct} per question answered so far,
  // sent with the finished score so each card's misses can be tracked.
  let quizAnswers = [];
  let quizFlipped = false;

  async function fetchJSON(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  function shuffled(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.add("show");
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  // Sets belong to a group (from the optional "group" in their JSON file):
  // plain vocabulary by default, or e.g. "Conjugations". Groups are listed
  // with the default one first, then the rest in the order they first appear.
  const DEFAULT_GROUP = "Vocabulary";

  function orderedGroups(items) {
    const seen = [];
    for (const item of items) {
      const group = item.group || DEFAULT_GROUP;
      if (!seen.includes(group)) seen.push(group);
    }
    return seen.sort((a, b) => (a === DEFAULT_GROUP ? -1 : b === DEFAULT_GROUP ? 1 : 0));
  }

  // A set that's finished for this direction - every card Learned and
  // Retained - has nothing left to study, so it's left out of the menu.
  // (Sets stay on the Dashboard. One you just finished stays in the menu until
  // the page or direction reloads, so it doesn't vanish mid-session.)
  function isCompleted(cat) {
    return cat.total > 0 && cat.mastered >= cat.total && cat.retained >= cat.total;
  }

  async function loadCategories() {
    const data = await fetchJSON(`/api/categories?mode=${currentMode}`);
    const categories = data.categories.filter((c) => !isCompleted(c));
    const prevSelection = categorySelect.value;
    categorySelect.innerHTML = "";
    for (const group of orderedGroups(categories)) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group;
      for (const cat of categories.filter((c) => (c.group || DEFAULT_GROUP) === group)) {
        const opt = document.createElement("option");
        opt.value = cat.id;
        opt.textContent = categoryOptionLabel(cat);
        optgroup.appendChild(opt);
      }
      categorySelect.appendChild(optgroup);
    }
    if (categories.length === 0) {
      // Everything is done in this direction.
      currentCard = null;
      currentCategoryId = null;
      categoryStats.textContent = "";
      cardArea.classList.add("hidden");
      roundComplete.classList.add("hidden");
      reviewStatus.classList.add("hidden");
      document.querySelector("#empty-state p").textContent =
        "🎉 Every set is fully learned and retained in this direction!";
      emptyState.classList.remove("hidden");
      return;
    }

    const toSelect = categories.find((c) => c.id === prevSelection)
      ? prevSelection
      : categories[0].id;
    currentCategoryId = toSelect;
    categorySelect.value = toSelect;
    await loadCategory(currentCategoryId);
  }

  function categoryOptionLabel(cat) {
    return `${cat.name} (${cat.mastered} learned, ${cat.retained} retained / ${cat.total})`;
  }

  async function loadCategory(categoryId) {
    currentCategoryId = categoryId;
    forceReviewAll = false;
    reviewAllToggle.checked = false;
    currentCategoryData = await fetchJSON(`/api/category/${categoryId}?mode=${currentMode}`);
    updateStatsLabel();
    updateReviewStatus();
    startRound();
  }

  function updateStatsLabel() {
    const cards = currentCategoryData.cards;
    const mastered = cards.filter((c) => c.mastered).length;
    const retained = cards.filter((c) => c.retained).length;
    categoryStats.textContent = `${mastered}/${cards.length} learned · ${retained}/${cards.length} retained`;
    const opt = [...categorySelect.options].find((o) => o.value === currentCategoryId);
    if (opt) {
      opt.textContent = categoryOptionLabel({
        name: currentCategoryData.name,
        mastered,
        retained,
        total: cards.length,
      });
    }
  }

  // Days from today (local midnight) until an ISO "YYYY-MM-DD" date.
  function daysUntil(isoDateStr) {
    const target = new Date(isoDateStr + "T00:00:00");
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((target - todayMidnight) / (1000 * 60 * 60 * 24));
  }

  // Surfaces what's happening with words that are Learned but not yet
  // Retained - either "N due right now" or "next check-in in N days" -
  // since otherwise those words just silently vanish from the round and
  // it's not obvious they're still being tracked at all.
  function updateReviewStatus() {
    const waiting = currentCategoryData.cards.filter((c) => c.mastered && !c.retained);
    const dueNow = waiting.filter((c) => c.dueForReview).length;

    if (dueNow > 0) {
      reviewStatus.textContent =
        `🔁 ${dueNow} word${dueNow === 1 ? "" : "s"} due for a retention check-in right now`;
      reviewStatus.classList.remove("hidden");
      return;
    }

    const upcoming = waiting.filter((c) => c.nextReviewDue).map((c) => c.nextReviewDue).sort();
    if (upcoming.length === 0) {
      reviewStatus.classList.add("hidden");
      return;
    }
    const days = Math.max(0, daysUntil(upcoming[0]));
    reviewStatus.textContent =
      `🔁 Next retention check-in in ${days} day${days === 1 ? "" : "s"} ` +
      `(${upcoming.length} word${upcoming.length === 1 ? "" : "s"} scheduled)`;
    reviewStatus.classList.remove("hidden");
  }

  // A card is eligible for the current round if it hasn't reached
  // long-term "retained" status yet, and is either still being learned
  // (not mastered) or is due for its next spaced-repetition check-in.
  function isEligible(card) {
    if (forceReviewAll) return true;
    if (card.retained) return false;
    if (!card.mastered) return true;
    return card.dueForReview;
  }

  // Starts a fresh pass through the set: every eligible card exactly once,
  // in a random order, with no repeats until the pass is finished.
  function startRound() {
    const cards = currentCategoryData.cards;
    const source = cards.filter(isEligible);

    if (source.length === 0) {
      roundComplete.classList.add("hidden");
      cardArea.classList.add("hidden");
      showEmptyState(cards);
      currentCard = null;
      return;
    }

    emptyState.classList.add("hidden");
    roundComplete.classList.add("hidden");
    cardArea.classList.remove("hidden");

    roundQueue = shuffled(source);
    roundSize = roundQueue.length;
    showNextCard();
  }

  function showEmptyState(cards) {
    const total = cards.length;
    const retained = cards.filter((c) => c.retained).length;
    const waiting = cards.filter((c) => c.mastered && !c.retained && !c.dueForReview).length;
    const message = document.querySelector("#empty-state p");

    if (retained === total) {
      message.textContent = "🎉 Every card in this category is fully retained (long-term mastery)!";
    } else if (waiting > 0) {
      message.textContent = `✅ Nothing due right now — ${waiting} word${waiting === 1 ? "" : "s"} ` +
        `${waiting === 1 ? "is" : "are"} waiting for its next scheduled review. Check back in a few days!`;
    } else {
      message.textContent = "🎉 You've mastered every card in this category!";
    }
    emptyState.classList.remove("hidden");
  }

  function showNextCard() {
    if (roundQueue.length === 0) {
      finishRound();
      return;
    }
    currentCard = roundQueue.shift();
    isFlipped = false;

    reviewBadge.classList.toggle("hidden", !currentCard.dueForReview);
    roundProgress.textContent = `Card ${roundSize - roundQueue.length} of ${roundSize}`;
    updateStreakDots();

    const promptText = currentMode === "fi-en" ? currentCard.fi : currentCard.en;
    const answerText = currentMode === "fi-en" ? currentCard.en : currentCard.fi;

    // Reset to the prompt side instantly, with no flip animation - this
    // isn't a "flip back", it's a brand new card. Suspend the transition
    // while we apply the reset, then re-enable it on the *next* frame
    // (double rAF, not just a synchronous reflow) so we're certain the
    // browser has painted the reset state before transitions can apply
    // again - even if a previous flip animation was still in flight.
    cardEl.classList.add("no-transition");
    cardEl.classList.remove("flipped");
    frontText.textContent = promptText;
    backText.textContent = answerText;
    answerButtons.classList.add("hidden");
    updateHint();
    resetWordHint();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        cardEl.classList.remove("no-transition");
      });
    });

    cardEl.focus();
    scrollToBottom();
  }

  // Quiet per-card progress toward "Learned": one dot per correct answer
  // already banked in a row on this specific card. Hidden once the card is
  // mastered (dueForReview cards already show the review badge instead -
  // showing full dots there too would just be noise).
  function updateStreakDots() {
    if (!currentCard) {
      streakDots.classList.add("hidden");
      return;
    }

    if (currentCard.mastered) {
      // Learned: dots start fully blue (3/3), then turn green left-to-right
      // as each spaced retention check-in passes - all green once Retained.
      const n = currentCategoryData.reviewIntervals.length;
      const passed = Math.min(currentCard.reviewStage || 0, n);
      streakDots.innerHTML = "";
      for (let i = 0; i < n; i++) {
        const dot = document.createElement("span");
        dot.className = "streak-dot filled" + (i < passed ? " retained" : "");
        streakDots.appendChild(dot);
      }
      streakDots.title = currentCard.retained
        ? "Retained — long-term mastery achieved"
        : `${passed} of ${n} retention check-ins passed`;
      streakDots.classList.remove("hidden");
      return;
    }

    // Not yet Learned: dots fill blue left-to-right toward the streak needed.
    const threshold = currentCategoryData.masteryStreak;
    const streak = Math.min(currentCard.correctStreak || 0, threshold);
    streakDots.innerHTML = "";
    for (let i = 0; i < threshold; i++) {
      const dot = document.createElement("span");
      dot.className = "streak-dot" + (i < streak ? " filled" : "");
      streakDots.appendChild(dot);
    }
    streakDots.title = `${streak} of ${threshold} correct in a row toward Learned`;
    streakDots.classList.remove("hidden");
  }

  function finishRound() {
    currentCard = null;
    cardArea.classList.add("hidden");
    roundCompleteMessage.textContent = forceReviewAll
      ? "🎉 You've reviewed every card in this set."
      : "🎉 You've been through every card due for practice in this set.";
    roundComplete.classList.remove("hidden");
  }

  function updateHint() {
    hintText.innerHTML = isFlipped
      ? 'Press <kbd>Space</kbd> = Got it &nbsp;·&nbsp; <kbd>Shift</kbd> = Missed it'
      : 'Press <kbd>Space</kbd> or click the card to flip';
  }

  function flipCard() {
    if (!currentCard) return;
    isFlipped = !isFlipped;
    cardEl.classList.toggle("flipped", isFlipped);
    answerButtons.classList.toggle("hidden", !isFlipped);
    updateHint();
    scrollToBottom();
  }

  // Keeps whatever's currently at the bottom of the flow (the answer
  // buttons once flipped, or just below the card otherwise) in view by
  // default, so on a phone you're not stuck scrolling down after every
  // flip - scrolling up is what you do to see the header/stats instead.
  // Runs after layout settles, since toggling .hidden changes page height.
  function scrollToBottom() {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    });
  }

  // The word-trick mnemonic hint - separate from the flip instructions,
  // and always tied to the Finnish word, so it's useful in either
  // direction. Collapsed on every new card so it doesn't carry over.
  function resetWordHint() {
    wordHintPanel.classList.add("hidden");
    wordHintPanel.textContent = "";
    wordHintBtn.textContent = "💡 Word trick";
    wordHintBtn.classList.toggle("hidden", !currentCard || !currentCard.hint);
  }

  function toggleWordHint() {
    if (!currentCard || !currentCard.hint) return;
    const showing = !wordHintPanel.classList.contains("hidden");
    if (showing) {
      wordHintPanel.classList.add("hidden");
      wordHintBtn.textContent = "💡 Word trick";
    } else {
      wordHintPanel.textContent = currentCard.hint;
      wordHintPanel.classList.remove("hidden");
      wordHintBtn.textContent = "🙈 Hide trick";
    }
  }

  // True from the moment an answer is submitted until its save finishes and
  // the next card is showing. A second tap or keypress in that window would
  // otherwise submit the SAME card again - double-counting it (e.g. pushing
  // a card's streak toward Learned twice off one real answer) - and the two
  // requests would hit the server at once. Extra input is simply ignored.
  let answerInFlight = false;

  async function answer(correct) {
    if (!currentCard || answerInFlight) return;
    answerInFlight = true;
    try {
      await submitAnswer(correct);
    } finally {
      answerInFlight = false;
    }
  }

  async function submitAnswer(correct) {
    if (!currentCard) return;
    const cardId = currentCard.id;
    const cardFi = currentCard.fi;
    try {
      const result = await fetchJSON("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: currentCategoryId, cardId, correct, mode: currentMode }),
      });
      const localCard = currentCategoryData.cards.find((c) => c.id === cardId);
      if (localCard) Object.assign(localCard, result.progress);
      updateStatsLabel();
      updateReviewStatus();
      updateDueBadge();
      // A newly Learned word (or a miss that un-Learns one) can cross the
      // 40-word line that unlocks/locks the quiz.
      refreshQuizStatus();

      if (result.newlyRetained) {
        showToast(`🌟 "${cardFi}" retained — long-term mastery!`);
      } else if (result.newlyMastered) {
        showToast(`✅ "${cardFi}" learned!`);
      }
    } catch (err) {
      console.error(err);
      alert("Couldn't save progress: " + err.message);
    }
    showNextCard();
  }

  // --- Dashboard ---

  function pct(n, total) {
    return total === 0 ? 0 : Math.round((n / total) * 100);
  }

  function barCell(n, total, kind) {
    return `
      <div class="cell-bar">
        <div class="cell-bar-track">
          <div class="cell-bar-fill ${kind}" style="width:${pct(n, total)}%"></div>
        </div>
        <span class="cell-bar-num">${n}/${total}</span>
      </div>`;
  }

  // Fetches every category's stats in both directions and merges them into
  // one row per category - shared by the dashboard table and the due-review
  // badge/banner, so both stay consistent with a single source of truth.
  async function fetchCombinedCategoryStats() {
    const [fiEn, enFi] = await Promise.all([
      fetchJSON("/api/categories?mode=fi-en"),
      fetchJSON("/api/categories?mode=en-fi"),
    ]);

    const byId = new Map();
    for (const c of fiEn.categories) {
      byId.set(c.id, { id: c.id, name: c.name, group: c.group, total: c.total, fiEn: c });
    }
    for (const c of enFi.categories) {
      const row = byId.get(c.id) || { id: c.id, name: c.name, group: c.group, total: c.total };
      row.enFi = c;
      byId.set(c.id, row);
    }
    return [...byId.values()];
  }

  // Keeps the small red badge on the Dashboard tab in sync with how many
  // words (summed across every category and both directions) are due for
  // a retention check-in right now - visible without opening Dashboard.
  async function updateDueBadge() {
    try {
      const rows = await fetchCombinedCategoryStats();
      const total = rows.reduce(
        (sum, r) => sum + (r.fiEn ? r.fiEn.dueForReview : 0) + (r.enFi ? r.enFi.dueForReview : 0),
        0
      );
      dueBadge.textContent = String(total);
      dueBadge.classList.toggle("hidden", total === 0);
    } catch (err) {
      console.error("Failed to update due badge", err);
    }
  }

  function renderDueSummary(rows) {
    const items = [];
    for (const r of rows) {
      if (r.fiEn && r.fiEn.dueForReview > 0) {
        items.push({ id: r.id, name: r.name, mode: "fi-en", label: "FI→EN", count: r.fiEn.dueForReview });
      }
      if (r.enFi && r.enFi.dueForReview > 0) {
        items.push({ id: r.id, name: r.name, mode: "en-fi", label: "EN→FI", count: r.enFi.dueForReview });
      }
    }

    if (items.length === 0) {
      dueSummaryEl.innerHTML =
        '<div class="due-summary-banner all-clear">✅ Nothing due for a retention check-in right now.</div>';
      return;
    }

    const totalDue = items.reduce((sum, i) => sum + i.count, 0);
    const listHtml = items
      .map(
        (i) => `
        <li>
          <button class="due-jump-btn" data-cat="${i.id}" data-mode="${i.mode}">
            ${i.name} (${i.label}): ${i.count} due
          </button>
        </li>`
      )
      .join("");

    dueSummaryEl.innerHTML = `
      <div class="due-summary-banner">
        🔁 <strong>${totalDue} word${totalDue === 1 ? "" : "s"}</strong> due for a retention
        check-in right now, across ${items.length} set${items.length === 1 ? "" : "s"}:
        <ul class="due-summary-list">${listHtml}</ul>
      </div>`;

    dueSummaryEl.querySelectorAll(".due-jump-btn").forEach((btn) => {
      btn.addEventListener("click", () => jumpToReview(btn.dataset.cat, btn.dataset.mode));
    });
  }

  // Jumps straight from a due-review banner item into that exact
  // category+direction in Study mode, instead of making you go find it
  // yourself in the pickers.
  async function jumpToReview(categoryId, mode) {
    currentMode = mode;
    modeSelect.value = mode;
    categorySelect.value = categoryId;
    showView("study");
    await loadCategories();
  }

  // One dashboard section per group (Vocabulary, Conjugations, ...), each
  // with its own totals and table - so easy pattern drills never dilute the
  // vocabulary numbers, and vice versa.
  function renderDashboardGroup(group, rows) {
    const sum = (pick) => rows.reduce((total, r) => total + pick(r), 0);
    const totalCards = sum((r) => r.total || 0);

    const cards = [
      { value: `${sum((r) => (r.fiEn ? r.fiEn.mastered : 0))}/${totalCards}`, label: "Learned · FI→EN" },
      { value: `${sum((r) => (r.fiEn ? r.fiEn.retained : 0))}/${totalCards}`, label: "Retained · FI→EN" },
      { value: `${sum((r) => (r.enFi ? r.enFi.mastered : 0))}/${totalCards}`, label: "Learned · EN→FI" },
      { value: `${sum((r) => (r.enFi ? r.enFi.retained : 0))}/${totalCards}`, label: "Retained · EN→FI" },
    ]
      .map(
        (c) => `
        <div class="summary-card">
          <div class="summary-value">${c.value}</div>
          <div class="summary-label">${c.label}</div>
        </div>`
      )
      .join("");

    const body = rows
      .map((r) => {
        const total = r.total || 0;
        return `
        <tr>
          <td>${r.name}</td>
          <td>${total}</td>
          <td>${barCell(r.fiEn ? r.fiEn.mastered : 0, total, "learned")}</td>
          <td>${barCell(r.fiEn ? r.fiEn.retained : 0, total, "retained")}</td>
          <td>${barCell(r.enFi ? r.enFi.mastered : 0, total, "learned")}</td>
          <td>${barCell(r.enFi ? r.enFi.retained : 0, total, "retained")}</td>
        </tr>`;
      })
      .join("");

    return `
      <section class="dashboard-group">
        <h3 class="dashboard-group-title">${group}</h3>
        <div class="dashboard-summary">${cards}</div>
        <div class="dashboard-table-wrap">
          <table class="dashboard-table">
            <thead>
              <tr>
                <th rowspan="2" class="dash-category-col">Category</th>
                <th rowspan="2">${group === DEFAULT_GROUP ? "Words" : "Cards"}</th>
                <th colspan="2">Finnish → English</th>
                <th colspan="2">English → Finnish</th>
              </tr>
              <tr>
                <th>Learned</th>
                <th>Retained</th>
                <th>Learned</th>
                <th>Retained</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>`;
  }

  async function loadDashboard() {
    dashboardGroups.innerHTML = '<p class="dash-loading">Loading…</p>';
    dueSummaryEl.innerHTML = "";

    const rows = await fetchCombinedCategoryStats();
    renderDueSummary(rows);

    dashboardGroups.innerHTML = orderedGroups(rows)
      .map((group) =>
        renderDashboardGroup(group, rows.filter((r) => (r.group || DEFAULT_GROUP) === group))
      )
      .join("");
  }

  // --- Mastery Quiz ---
  //
  // A check-up over a random deck of Learned/Retained words. Nothing here
  // ever calls /api/answer: individual quiz answers live only in this
  // page's memory, and only the finished score is sent to the server, so a
  // quiz can't change any word's progress in either direction.

  const DIRECTION_LABELS = { "fi-en": "Finnish → English", "en-fi": "English → Finnish" };

  function quizInProgress() {
    return quizDeck.length > 0;
  }

  function formatShortDate(isoDate) {
    return new Date(isoDate + "T00:00:00").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  // The Quiz tab and the dashboard tracker only exist once enough words are
  // Learned/Retained; anything that goes wrong fetching status (e.g. an
  // older server without the endpoint) just means the quiz isn't offered.
  async function refreshQuizStatus() {
    try {
      quizStatus = await fetchJSON("/api/quiz/status");
    } catch (err) {
      quizStatus = null;
    }
    const anyEligible = !!(
      quizStatus &&
      (quizStatus.eligible ||
        (quizStatus.lookalike && quizStatus.lookalike.eligible) ||
        (quizStatus.conjugation && quizStatus.conjugation.eligible))
    );
    tabQuiz.classList.toggle("hidden", !anyEligible);
    if (!anyEligible && !quizView.classList.contains("hidden")) {
      quizDeck = [];
      showView("study");
    }
    renderQuizTracker();
    updateQuizLastLine();
  }

  function daysAgoText(since) {
    return since === 0 ? "today" : `${since} day${since === 1 ? "" : "s"} ago`;
  }

  function updateQuizLastLine() {
    if (!quizStatus) return;
    const mastery = quizStatus;
    const look = quizStatus.lookalike;

    quizStartBtn.disabled = !mastery.eligible;
    if (!mastery.eligible) {
      quizLastLine.textContent =
        `Unlocks at ${mastery.required} Learned words (you have ${mastery.learnedWords}).`;
    } else if (!mastery.recent[0]) {
      quizLastLine.textContent = "You haven't taken a quiz yet.";
    } else {
      quizLastLine.textContent =
        `Last quiz: ${mastery.recent[0].percent}% (${daysAgoText(mastery.daysSinceLast)}).`;
    }

    quizLookalikeBtn.disabled = !(look && look.eligible);
    if (!look) {
      quizLookalikeLastLine.textContent = "";
    } else if (!look.eligible) {
      quizLookalikeLastLine.textContent =
        `Unlocks at ${look.required} look-alike words (you have ${look.words}).`;
    } else if (!look.recent[0]) {
      quizLookalikeLastLine.textContent = "You haven't taken a look-alike quiz yet.";
    } else {
      quizLookalikeLastLine.textContent =
        `Last look-alike quiz: ${look.recent[0].percent}% (${daysAgoText(look.daysSinceLast)}).`;
    }

    const conj = quizStatus.conjugation;
    quizConjugationBtn.disabled = !(conj && conj.eligible);
    if (!conj) {
      quizConjugationLastLine.textContent = "";
    } else if (!conj.eligible) {
      quizConjugationLastLine.textContent =
        `Unlocks at ${conj.required} Learned conjugation cards (you have ${conj.words}).`;
    } else if (!conj.recent[0]) {
      quizConjugationLastLine.textContent = "You haven't taken a conjugation quiz yet.";
    } else {
      quizConjugationLastLine.textContent =
        `Last conjugation quiz: ${conj.recent[0].percent}% (${daysAgoText(conj.daysSinceLast)}).`;
    }
  }

  // One dashboard card for a quiz mode: days since its last completed quiz
  // plus its last 5 scores.
  function quizTrackerCard(title, noun, s) {
    const sinceHtml =
      s.daysSinceLast === null
        ? `No ${noun} completed yet`
        : `Days since last ${noun}: <strong>${s.daysSinceLast}</strong>`;
    const scoresHtml = s.recent.length
      ? `<ul class="quiz-tracker-scores">${s.recent
          .map(
            (r) => `
            <li>
              <span class="qt-date">${formatShortDate(r.date)}</span>
              <span class="qt-track"><span class="qt-fill" style="width:${r.percent}%"></span></span>
              <span class="qt-score">${r.percent}% · ${r.correct}/${r.total}</span>
            </li>`
          )
          .join("")}</ul>`
      : `<p class="quiz-tracker-empty">Your last 5 ${noun} scores will show up here.</p>`;
    return `
      <div class="quiz-tracker-card">
        <div class="quiz-tracker-head">
          <span class="quiz-tracker-title">${title}</span>
          <span class="quiz-tracker-since">${sinceHtml}</span>
        </div>
        ${scoresHtml}
        <button class="quiz-tracker-btn" type="button">Take the quiz</button>
      </div>`;
  }

  function renderQuizTracker() {
    const cards = [];
    if (quizStatus && quizStatus.eligible) {
      cards.push(quizTrackerCard("Mastery Quiz", "quiz", quizStatus));
    }
    if (quizStatus && quizStatus.lookalike && quizStatus.lookalike.eligible) {
      cards.push(quizTrackerCard("Look-alike Quiz", "look-alike quiz", quizStatus.lookalike));
    }
    if (quizStatus && quizStatus.conjugation && quizStatus.conjugation.eligible) {
      cards.push(quizTrackerCard("Conjugation Quiz", "conjugation quiz", quizStatus.conjugation));
    }
    quizTrackerEl.innerHTML = cards.join("");
    quizTrackerEl
      .querySelectorAll(".quiz-tracker-btn")
      .forEach((btn) => btn.addEventListener("click", () => showView("quiz")));
  }

  // Always opens on the intro: leaving the Quiz tab abandons a quiz that's
  // partway through (see showView), so there's never a half-finished one to
  // resume and no separate "quit" control to tap by accident.
  function openQuizView() {
    refreshQuizStatus();
    quizResult.classList.add("hidden");
    quizIntro.classList.remove("hidden");
    quizCardArea.classList.add("hidden");
  }

  async function startQuiz(mode) {
    quizStartBtn.disabled = true;
    quizLookalikeBtn.disabled = true;
    quizConjugationBtn.disabled = true;
    quizAgainBtn.disabled = true;
    try {
      const data = await fetchJSON("/api/quiz/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      quizMode = mode;
      quizDeck = data.deck;
      quizIndex = 0;
      quizCorrect = 0;
      quizAnswers = [];
      quizIntro.classList.add("hidden");
      quizResult.classList.add("hidden");
      quizCardArea.classList.remove("hidden");
      showQuizQuestion();
    } catch (err) {
      alert("Couldn't start the quiz: " + err.message);
      refreshQuizStatus();
    } finally {
      quizAgainBtn.disabled = false;
      updateQuizLastLine(); // re-enables each start button only if it's unlocked
    }
  }

  function updateQuizHint() {
    quizHintText.innerHTML = quizFlipped
      ? 'Press <kbd>Space</kbd> = Got it &nbsp;·&nbsp; <kbd>Shift</kbd> = Missed it'
      : 'Press <kbd>Space</kbd> or click the card to flip';
  }

  function showQuizQuestion() {
    const q = quizDeck[quizIndex];
    quizFlipped = false;
    quizProgress.textContent = `Question ${quizIndex + 1} of ${quizDeck.length}`;
    // Deliberately just the direction: which set a word came from would be a
    // giveaway, and the quiz is meant to test recall without that context.
    quizDirectionLabel.textContent = DIRECTION_LABELS[q.direction];

    // Same instant reset as study mode: a new question isn't a "flip back".
    quizCardEl.classList.add("no-transition");
    quizCardEl.classList.remove("flipped");
    quizFrontText.textContent = q.direction === "fi-en" ? q.fi : q.en;
    quizBackText.textContent = q.direction === "fi-en" ? q.en : q.fi;
    quizAnswerButtons.classList.add("hidden");
    updateQuizHint();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => quizCardEl.classList.remove("no-transition"));
    });
    quizCardEl.focus();
    scrollToBottom();
  }

  function flipQuizCard() {
    if (!quizInProgress()) return;
    quizFlipped = !quizFlipped;
    quizCardEl.classList.toggle("flipped", quizFlipped);
    quizAnswerButtons.classList.toggle("hidden", !quizFlipped);
    updateQuizHint();
    scrollToBottom();
  }

  function answerQuiz(correct) {
    if (!quizInProgress() || !quizFlipped) return;
    const q = quizDeck[quizIndex];
    quizAnswers.push({ category: q.category, id: q.id, direction: q.direction, correct });
    if (correct) quizCorrect += 1;
    quizIndex += 1;
    if (quizIndex >= quizDeck.length) {
      finishQuiz();
    } else {
      showQuizQuestion();
    }
  }

  async function finishQuiz() {
    const total = quizDeck.length;
    const correct = quizCorrect;
    const answers = quizAnswers;
    quizAnswers = [];
    quizDeck = []; // no longer in progress; also blocks any stray extra answers

    quizCardArea.classList.add("hidden");
    quizResultPercent.textContent = `${Math.round((100 * correct) / total)}%`;
    quizResultDetail.textContent = `${correct} of ${total} correct`;
    quizSavedNote.textContent = "Saving your score…";
    quizResult.classList.remove("hidden");
    window.scrollTo({ top: 0 });

    try {
      await fetchJSON("/api/quiz/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: quizMode, correct, total, answers }),
      });
      quizSavedNote.textContent =
        "Saved to your quiz history. No word's progress was changed.";
    } catch (err) {
      console.error(err);
      quizSavedNote.textContent =
        `Couldn't save this score (${err.message}). No word's progress was changed.`;
    }
    refreshQuizStatus();
  }

  function handleQuizKey(e) {
    if (quizCardArea.classList.contains("hidden") || !quizInProgress()) return;
    if (e.code === "Space") {
      if (e.repeat) return;
      e.preventDefault();
      if (!quizFlipped) {
        flipQuizCard();
      } else {
        answerQuiz(true);
      }
    } else if (e.key === "Shift") {
      if (e.repeat || !quizFlipped) return;
      e.preventDefault();
      answerQuiz(false);
    }
  }

  function showView(view) {
    // Navigating away from the Quiz tab is how you abandon a quiz: nothing
    // gets recorded, and coming back starts from the intro.
    if (view !== "quiz") quizDeck = [];

    studyView.classList.toggle("hidden", view !== "study");
    dashboardView.classList.toggle("hidden", view !== "dashboard");
    quizView.classList.toggle("hidden", view !== "quiz");
    tabStudy.classList.toggle("active", view === "study");
    tabDashboard.classList.toggle("active", view === "dashboard");
    tabQuiz.classList.toggle("active", view === "quiz");

    if (view === "dashboard") {
      refreshQuizStatus();
      loadDashboard().catch((err) => {
        console.error(err);
        dashboardGroups.innerHTML = `<p class="dash-loading" style="color:red;">Failed to load: ${err.message}</p>`;
      });
    } else if (view === "quiz" && !quizInProgress()) {
      // (Re-tapping the Quiz tab mid-quiz is a no-op rather than a reset.)
      openQuizView();
    }
  }

  // --- Event wiring ---

  tabStudy.addEventListener("click", () => showView("study"));
  tabDashboard.addEventListener("click", () => showView("dashboard"));
  tabQuiz.addEventListener("click", () => showView("quiz"));

  quizStartBtn.addEventListener("click", () => startQuiz("mastery"));
  quizLookalikeBtn.addEventListener("click", () => startQuiz("lookalike"));
  quizConjugationBtn.addEventListener("click", () => startQuiz("conjugation"));
  quizAgainBtn.addEventListener("click", () => startQuiz(quizMode));
  quizToDashboardBtn.addEventListener("click", () => showView("dashboard"));
  quizCardEl.addEventListener("click", flipQuizCard);
  quizBtnRight.addEventListener("click", () => answerQuiz(true));
  quizBtnWrong.addEventListener("click", () => answerQuiz(false));

  categorySelect.addEventListener("change", () => {
    loadCategory(categorySelect.value);
  });

  modeSelect.addEventListener("change", () => {
    currentMode = modeSelect.value;
    loadCategories();
  });

  cardEl.addEventListener("click", flipCard);

  wordHintBtn.addEventListener("click", toggleWordHint);

  document.addEventListener("keydown", (e) => {
    // Let native controls (dropdowns, buttons) handle their own key
    // interaction; otherwise Space on a focused button would both
    // trigger our handler AND the button's own native activation.
    const activeTag = document.activeElement && document.activeElement.tagName;
    if (activeTag === "SELECT" || activeTag === "BUTTON" || activeTag === "INPUT") return;

    // Shortcuts only ever act on the view you're actually looking at.
    // (Without this, Space on the Dashboard or Quiz would flip - and
    // answer - the hidden study card.)
    if (!quizView.classList.contains("hidden")) {
      handleQuizKey(e);
      return;
    }
    if (studyView.classList.contains("hidden")) return;
    if (cardArea.classList.contains("hidden") || !currentCard) return;

    if (e.code === "Space") {
      if (e.repeat) return;
      e.preventDefault();
      if (!isFlipped) {
        flipCard();
      } else {
        answer(true);
      }
    } else if (e.key === "Shift") {
      if (e.repeat || !isFlipped) return;
      e.preventDefault();
      answer(false);
    }
  });

  btnRight.addEventListener("click", () => answer(true));
  btnWrong.addEventListener("click", () => answer(false));

  reviewAllBtn.addEventListener("click", () => {
    forceReviewAll = true;
    reviewAllToggle.checked = true;
    startRound();
  });

  reviewAllToggle.addEventListener("change", () => {
    forceReviewAll = reviewAllToggle.checked;
    startRound();
  });

  repeatSetBtn.addEventListener("click", () => {
    startRound();
  });

  chooseCategoryBtn.addEventListener("click", () => {
    if (typeof categorySelect.showPicker === "function") {
      categorySelect.showPicker();
    } else {
      categorySelect.focus();
    }
  });

  loadCategories().catch((err) => {
    console.error(err);
    document.body.innerHTML = `<p style="padding:20px;color:red;">Failed to load: ${err.message}</p>`;
  });

  // So the Dashboard tab's due-review count is visible right away, even
  // before ever opening the Dashboard.
  updateDueBadge();
  // ...and so the Quiz tab appears right away once it's unlocked.
  refreshQuizStatus();

  // Best-effort - browsers only allow service workers on HTTPS or
  // localhost, so this silently no-ops over plain http://<tailscale-ip>.
  // The app works fine either way; this just adds installability/offline
  // resilience where the browser permits it.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
