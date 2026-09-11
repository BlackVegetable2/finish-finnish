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
  const dashboardSummary = document.getElementById("dashboard-summary");
  const dashboardBody = document.getElementById("dashboard-body");
  const wordHintBtn = document.getElementById("word-hint-btn");
  const wordHintPanel = document.getElementById("word-hint-panel");

  let currentCategoryId = null;
  let currentMode = "fi-en"; // "fi-en" = show Finnish, translate to English
  let currentCategoryData = null; // full payload from /api/category/:id
  let roundQueue = []; // shuffled cards left to see this pass, no repeats
  let roundSize = 0; // how many cards this pass started with
  let currentCard = null;
  let isFlipped = false;
  let forceReviewAll = false;
  let toastTimer = null;

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

  async function loadCategories() {
    const data = await fetchJSON(`/api/categories?mode=${currentMode}`);
    const prevSelection = categorySelect.value;
    categorySelect.innerHTML = "";
    for (const cat of data.categories) {
      const opt = document.createElement("option");
      opt.value = cat.id;
      opt.textContent = categoryOptionLabel(cat);
      categorySelect.appendChild(opt);
    }
    if (data.categories.length === 0) return;

    const toSelect = data.categories.find((c) => c.id === prevSelection)
      ? prevSelection
      : data.categories[0].id;
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
    currentCategoryData = await fetchJSON(`/api/category/${categoryId}?mode=${currentMode}`);
    updateStatsLabel();
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

  async function answer(correct) {
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

  async function loadDashboard() {
    dashboardBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--gray); padding:24px;">Loading…</td></tr>`;

    const [fiEn, enFi] = await Promise.all([
      fetchJSON("/api/categories?mode=fi-en"),
      fetchJSON("/api/categories?mode=en-fi"),
    ]);

    const byId = new Map();
    for (const c of fiEn.categories) byId.set(c.id, { id: c.id, name: c.name, total: c.total, fiEn: c });
    for (const c of enFi.categories) {
      const row = byId.get(c.id) || { id: c.id, name: c.name, total: c.total };
      row.enFi = c;
      byId.set(c.id, row);
    }

    const rows = [...byId.values()];

    // Summary cards, totaled across every category.
    const totalWords = rows.reduce((sum, r) => sum + (r.total || 0), 0);
    const totalLearnedFiEn = rows.reduce((sum, r) => sum + (r.fiEn ? r.fiEn.mastered : 0), 0);
    const totalRetainedFiEn = rows.reduce((sum, r) => sum + (r.fiEn ? r.fiEn.retained : 0), 0);
    const totalLearnedEnFi = rows.reduce((sum, r) => sum + (r.enFi ? r.enFi.mastered : 0), 0);
    const totalRetainedEnFi = rows.reduce((sum, r) => sum + (r.enFi ? r.enFi.retained : 0), 0);

    dashboardSummary.innerHTML = [
      { value: totalWords, label: "Total words" },
      { value: `${totalLearnedFiEn}/${totalWords}`, label: "Learned · FI→EN" },
      { value: `${totalRetainedFiEn}/${totalWords}`, label: "Retained · FI→EN" },
      { value: `${totalLearnedEnFi}/${totalWords}`, label: "Learned · EN→FI" },
      { value: `${totalRetainedEnFi}/${totalWords}`, label: "Retained · EN→FI" },
    ]
      .map(
        (c) => `
        <div class="summary-card">
          <div class="summary-value">${c.value}</div>
          <div class="summary-label">${c.label}</div>
        </div>`
      )
      .join("");

    dashboardBody.innerHTML = rows
      .map((r) => {
        const total = r.total || 0;
        const fiEnLearned = r.fiEn ? r.fiEn.mastered : 0;
        const fiEnRetained = r.fiEn ? r.fiEn.retained : 0;
        const enFiLearned = r.enFi ? r.enFi.mastered : 0;
        const enFiRetained = r.enFi ? r.enFi.retained : 0;
        return `
        <tr>
          <td>${r.name}</td>
          <td>${total}</td>
          <td>${barCell(fiEnLearned, total, "learned")}</td>
          <td>${barCell(fiEnRetained, total, "retained")}</td>
          <td>${barCell(enFiLearned, total, "learned")}</td>
          <td>${barCell(enFiRetained, total, "retained")}</td>
        </tr>`;
      })
      .join("");
  }

  function showView(view) {
    const isStudy = view === "study";
    studyView.classList.toggle("hidden", !isStudy);
    dashboardView.classList.toggle("hidden", isStudy);
    tabStudy.classList.toggle("active", isStudy);
    tabDashboard.classList.toggle("active", !isStudy);
    if (!isStudy) {
      loadDashboard().catch((err) => {
        console.error(err);
        dashboardBody.innerHTML = `<tr><td colspan="6" style="color:red; text-align:center; padding:20px;">Failed to load: ${err.message}</td></tr>`;
      });
    }
  }

  // --- Event wiring ---

  tabStudy.addEventListener("click", () => showView("study"));
  tabDashboard.addEventListener("click", () => showView("dashboard"));

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
    if (cardArea.classList.contains("hidden") || !currentCard) return;
    // Let native controls (dropdowns, buttons) handle their own key
    // interaction; otherwise Space on a focused button would both
    // trigger our handler AND the button's own native activation.
    const activeTag = document.activeElement && document.activeElement.tagName;
    if (activeTag === "SELECT" || activeTag === "BUTTON" || activeTag === "INPUT") return;

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

  // Best-effort - browsers only allow service workers on HTTPS or
  // localhost, so this silently no-ops over plain http://<tailscale-ip>.
  // The app works fine either way; this just adds installability/offline
  // resilience where the browser permits it.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
