// popup.js

// Global variables for Firebase (will be provided by the Canvas environment)
// These are placeholders and will be populated at runtime by the Canvas environment.
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? initialAuthToken : null;

// Initialize Firebase (if needed, though for this extension, direct API calls are used)
// For this specific extension, Firebase is not directly used for data persistence,
// but the global variables are included as per instructions for all code generation.
// If data persistence was explicitly requested, Firestore would be initialized here.

document.addEventListener('DOMContentLoaded', async () => {
    const tabsList = document.getElementById('tabs-list');
    const selectedTabsCount = document.getElementById('selected-tabs-count');
    const chatHistory = document.getElementById('chat-history');
    const userQueryInput = document.getElementById('user-query');
    const sendButton = document.getElementById('send-button');
    const errorMessageDiv = document.getElementById('error-message'); // New: Error message div

    let availableTabs = []; // Stores all available tabs with their IDs and titles
    let selectedTabIds = new Set(); // Stores IDs of currently selected tabs
    let chatMessages = []; // Stores chat history for display

    // Function to display an error message
    function showErrorMessage(message) {
        errorMessageDiv.textContent = message;
        errorMessageDiv.style.display = 'block'; // Show the error message
    }

    // Function to hide the error message
    function hideErrorMessage() {
        errorMessageDiv.textContent = '';
        errorMessageDiv.style.display = 'none'; // Hide the error message
    }

    // Function to fetch and display available tabs
    async function fetchAndDisplayTabs() {
        hideErrorMessage(); // Clear any previous errors
        try {
            const tabs = await chrome.tabs.query({ currentWindow: true });
            availableTabs = tabs;
            tabsList.innerHTML = ''; // Clear existing list

            const summarizableTabs = tabs.filter(tab =>
                tab.url &&
                !tab.url.startsWith("chrome://") &&
                !tab.url.startsWith("about:") &&
                !tab.url.startsWith("file://") &&
                tab.title &&
                tab.title !== "New Tab"
            );

            if (summarizableTabs.length === 0) {
                tabsList.innerHTML = '<p class="no-tabs-message">No summarizable tabs found (e.g., new tabs, extension pages).</p>';
                sendButton.disabled = true;
                updateSelectedTabsCount();
                return;
            }

            summarizableTabs.forEach(tab => {
                const tabItem = document.createElement('div');
                tabItem.className = 'tab-item';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `tab-${tab.id}`;
                checkbox.value = tab.id;
                checkbox.checked = selectedTabIds.has(tab.id);

                const label = document.createElement('label');
                label.htmlFor = `tab-${tab.id}`;
                const favicon = tab.favIconUrl ? `<img src="${tab.favIconUrl}" alt="favicon" style="width:16px; height:16px; margin-right:5px; border-radius: 3px;">` : '📄';
                label.innerHTML = `${favicon} <a href="${tab.url}" target="_blank" title="${tab.url}">${tab.title || tab.url}</a>`;

                tabItem.appendChild(checkbox);
                tabItem.appendChild(label);
                tabsList.appendChild(tabItem);


                checkbox.addEventListener('change', (event) => {
                    if (event.target.checked) {
                        selectedTabIds.add(parseInt(event.target.value));
                    } else {
                        selectedTabIds.delete(parseInt(event.target.value));
                    }
                    updateSelectedTabsCount();
                    hideErrorMessage();
                });
            });

            updateSelectedTabsCount();
            sendButton.disabled = false;
        } catch (error) {
            console.error("Error fetching and displaying tabs:", error);
            showErrorMessage("Error loading tabs. Please ensure necessary permissions are granted.");
            tabsList.innerHTML = '<p class="no-tabs-message">Could not load tabs.</p>';
            sendButton.disabled = true;
        }
    }

    function updateSelectedTabsCount() {
        selectedTabsCount.textContent = `${selectedTabIds.size} tabs selected`;
    }

    function addMessageToChat(message, type) {
        const messageElement = document.createElement('div');
        messageElement.className = `message ${type}-message`;
        messageElement.innerHTML = message;
        chatHistory.appendChild(messageElement);
        chatHistory.scrollTop = chatHistory.scrollHeight; // Scroll to bottom
        chatMessages.push({ text: message, type: type }); // Store for potential re-display or context
    }

    function showLoadingIndicator() {
        const loadingElement = document.createElement('div');
        loadingElement.className = 'loading-indicator';
        loadingElement.id = 'loading-indicator';
        loadingElement.textContent = 'Thinking';
        chatHistory.appendChild(loadingElement);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function removeLoadingIndicator() {
        const loadingElement = document.getElementById('loading-indicator');
        if (loadingElement) {
            loadingElement.remove();
        }
    }

    async function gatherSelectedTabContent() {
        const contents = [];
        const selectedTabs = availableTabs.filter(tab => selectedTabIds.has(tab.id));

        if (selectedTabs.length === 0) {
            showErrorMessage("Please select at least one tab to analyze.");
            return null;
        }

        for (const tab of selectedTabs) {
            try {

                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    function: () => document.body.innerText,
                });

                if (results && results[0] && results[0].result) {

                    const content = results[0].result.substring(0, 10000);
                    contents.push(`--- Tab: ${tab.title} (URL: ${tab.url}) ---\n${content}\n`);
                } else {

                    console.warn(`No content retrieved from tab ${tab.id}: ${tab.title}`);
                    addMessageToChat(`Could not retrieve content from "${tab.title}". It might be empty or a special page.`, "bot");
                }
            } catch (error) {
                console.error(`Error gathering content from tab ${tab.id}:`, error);

                addMessageToChat(`Could not gather content from "${tab.title}". It might be a restricted page (e.g., chrome:// pages) or encountered an error.`, "bot");
            }
        }
        return contents.join('\n\n');
    }


    async function sendQueryToAI() {
        hideErrorMessage();
        const userQuery = userQueryInput.value.trim();
        if (!userQuery) {
            showErrorMessage("Please enter a query.");
            return;
        }

        addMessageToChat(userQuery, "user");
        userQueryInput.value = '';

        showLoadingIndicator();
        sendButton.disabled = true;

        const pageContents = await gatherSelectedTabContent();

        if (!pageContents) {
            removeLoadingIndicator();
            sendButton.disabled = false;
            return;
        }

        const prompt = `You are an AI assistant that can answer questions about web page content. Keep your response under 300 words.
        Here is the content from the selected tabs:\n\n${pageContents}\n\nUser's question: ${userQuery}\n\nBased on the provided content, please answer the user's question.`;

        let chatHistoryForAPI = [{ role: "user", parts: [{ text: prompt }] }];

        try {
            const apiRes = await fetch(chrome.runtime.getURL("config.json"));
            const config = await apiRes.json();
            const apiKey = config["apiKey"];
            console.log("Loaded API Key:", apiKey);
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

            const payload = { contents: chatHistoryForAPI };

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            removeLoadingIndicator();
            sendButton.disabled = false; // Re-enable send button

            if (result.candidates && result.candidates.length > 0 &&
                result.candidates[0].content && result.candidates[0].content.parts &&
                result.candidates[0].content.parts.length > 0) {
                const aiResponse = result.candidates[0].content.parts[0].text;
                addMessageToChat(marked.parse(aiResponse), "bot");
            } else {
                addMessageToChat("Sorry, I couldn't get a response from the AI. Please try again.", "bot");
                showErrorMessage("AI response structure unexpected or empty. Check console for details.");
                console.error("AI response structure unexpected:", result);
            }
        } catch (error) {
            removeLoadingIndicator();
            sendButton.disabled = false; // Re-enable send button
            console.error("Error calling Gemini API:", error);
            showErrorMessage("An error occurred while communicating with the AI. Please check your internet connection or try again later.");
            addMessageToChat("An error occurred while communicating with the AI. Please try again.", "bot");
        }
    }

    // Event listener for the send button
    sendButton.addEventListener('click', sendQueryToAI);

    // Event listener for Enter key in the input field
    userQueryInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            sendQueryToAI();
        }
    });

    // Initial fetch and display of tabs when the popup opens
    fetchAndDisplayTabs();
});