// Converts a time string (e.g., "00:01:23,456") to milliseconds
function timeStringToMs(timeStr) {
  if (!timeStr) return 0;

  const trimmedTimeStr = timeStr.trim();

  // Match HH:MM:SS,ms format
  let match = trimmedTimeStr.match(
    /(\d{2})\s*:\s*(\d{2})\s*:\s*(\d{2})[.,](\d{3})/
  );
  if (match) {
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3], 10);
    const milliseconds = parseInt(match[4], 10);
    return hours * 3600000 + minutes * 60000 + seconds * 1000 + milliseconds;
  }

  // Match MM:SS,ms format (missing hours)
  match = trimmedTimeStr.match(/(\d{2})\s*:\s*(\d{2})[.,](\d{3})/);
  if (match) {
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const milliseconds = parseInt(match[3], 10);
    return minutes * 60000 + seconds * 1000 + milliseconds;
  }

  console.warn("Could not parse time string:", `"${trimmedTimeStr}"`);
  return 0;
}

// Parses SRT text into an array of subtitle objects
function parseSrt(srtText) {
  if (!srtText || typeof srtText !== "string") {
    console.error("Invalid SRT text input:", srtText);
    return [];
  }

  console.log("Attempting to parse SRT:\n", srtText);

  const subtitles = [];
  const srtBlockRegex =
    /(\d+)\s*([\d:,.-]+)\s*-->\s*([\d:,.-]+)\s*((?:.|\n(?!(\d+\s*[\d:,.-]+\s*-->)))+)/g;

  let match;
  while ((match = srtBlockRegex.exec(srtText)) !== null) {
    const index = parseInt(match[1], 10);
    const startTimeStr = match[2].trim().replace(".", ",");
    const endTimeStr = match[3].trim().replace(".", ",");
    const text = match[4].trim().replace(/[\r\n]+/g, " ");

    const startTime = timeStringToMs(startTimeStr);
    const endTime = timeStringToMs(endTimeStr);

    if (!isNaN(startTime) && !isNaN(endTime) && text) {
      subtitles.push({ startTime, endTime, text });
    } else {
      console.warn(
        `Skipping malformed SRT block near index ${index}:`,
        match[0]
      );
    }
  }

  if (subtitles.length === 0 && srtText.trim().length > 0) {
    console.warn("Could not parse any valid SRT blocks from the text.");
  }

  console.log("Parsed subtitles count:", subtitles.length);
  return subtitles;
}

// Listener for messages from content or popup scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetchSubtitles") {
    const { videoUrl, apiKey } = message;
    const tabId = sender.tab?.id;

    console.log(
      "Background Script: Received fetchSubtitles request for URL:",
      videoUrl
    );

    const cleanedUrl = cleanYouTubeUrl(videoUrl);
    console.log("Background Script: Using cleaned URL for API:", cleanedUrl);

    // Check if subtitles for this video are already stored locally
    chrome.storage.local.get(cleanedUrl, (result) => {
      if (result[cleanedUrl]) {
        console.log("Subtitles found in local storage for this video.");
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            action: "subtitlesGenerated",
            subtitles: result[cleanedUrl],
          });
        }
        sendResponse({ status: "completed", cached: true });
      } else {
        console.log("No cached subtitles found. Fetching from Gemini API...");

        if (tabId) {
          chrome.runtime.sendMessage({
            action: "updatePopupStatus",
            text: "Calling Gemini API...",
            tabId: tabId,
          });
        }

        fetchSubtitlesFromGemini(cleanedUrl, apiKey, tabId)
          .then((subtitles) => {
            if (tabId) {
              chrome.tabs.sendMessage(tabId, {
                action: "subtitlesGenerated",
                subtitles: subtitles,
              });
              chrome.runtime.sendMessage({
                action: "updatePopupStatus",
                text: "Subtitles generated!",
                success: true,
                tabId: tabId,
              });
            }

            chrome.storage.local.set({ [cleanedUrl]: subtitles }, () => {
              console.log("Subtitles saved to local storage for:", cleanedUrl);
            });

            sendResponse({ status: "completed" });
          })
          .catch((error) => {
            console.error("Error fetching/parsing subtitles:", error);
            const errorMessage = `Error: ${
              error.message || "Unknown error fetching subtitles."
            }`;
            if (tabId) {
              chrome.runtime.sendMessage({
                action: "updatePopupStatus",
                text: errorMessage,
                error: true,
                tabId: tabId,
              });
            }
            sendResponse({ status: "error", message: error.message });
          });
      }
    });

    return true; // Keep the message channel open for async response
  }
});

// Cleans a YouTube URL to extract only the video ID and essential parameters
function cleanYouTubeUrl(originalUrl) {
  try {
    const url = new URL(originalUrl);
    const videoId = url.searchParams.get("v");
    if (videoId) {
      return `${url.protocol}//${url.hostname}${url.pathname}?v=${videoId}`;
    }
  } catch (e) {
    console.error("Error parsing URL for cleaning:", originalUrl, e);
  }
  return originalUrl;
}

// Fetches subtitles from the Gemini API
async function fetchSubtitlesFromGemini(videoUrl, apiKey, tabId) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  console.log(
    "Background Script: URL being embedded in Gemini prompt:",
    videoUrl
  );

  const prompt = `Generate ONLY the SRT subtitles for the YouTube video.\nDo NOT include any introductory text, explanations, or summaries.\nThe output MUST strictly follow the Standard SRT format:\n1\n00:00:01,000 --> 00:00:05,000\nSubtitle text line 1\nSubtitle text line 2 (if needed).\nEnsure timestamps use milliseconds (,) and sequential numbering is correct. Ensure time stamps are in the following format: HH:MM,ms, example: 00:00:01,000. DO NOT recite training data in the prompt.`;

  if (tabId) {
    chrome.runtime.sendMessage({
      action: "updatePopupStatus",
      text: "Waiting for Gemini response...",
      tabId: tabId,
    });
  }

  const response = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }, { file_data: { file_uri: `${videoUrl}` } }],
        },
      ],
    }),
  });

  if (!response.ok) {
    let errorData;
    try {
      errorData = await response.json();
      console.error("Gemini API Error Response:", errorData);
    } catch (e) {
      console.error(
        "Failed to parse Gemini error response:",
        await response.text()
      );
      throw new Error(
        `Gemini API request failed with status ${response.status}`
      );
    }
    throw new Error(
      `Gemini API error: ${
        errorData?.error?.message || `Status ${response.status}`
      }`
    );
  }

  const data = await response.json();
  console.log("Gemini API Success Response:", JSON.stringify(data, null, 2));

  if (tabId) {
    chrome.runtime.sendMessage({
      action: "updatePopupStatus",
      text: "Parsing Gemini response...",
      tabId: tabId,
    });
  }

  let srtText = "";
  if (
    data &&
    data.candidates &&
    data.candidates.length > 0 &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts.length > 0 &&
    data.candidates[0].content.parts[0].text
  ) {
    srtText = data.candidates[0].content.parts[0].text;

    const codeBlockMatch = srtText.match(/```(?:srt)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      console.log("Extracted SRT from markdown code block.");
      srtText = codeBlockMatch[1];
    }
  } else if (data?.promptFeedback?.blockReason) {
    console.error("Gemini response blocked:", data.promptFeedback.blockReason);
    throw new Error(
      `Content blocked by Gemini: ${data.promptFeedback.blockReason}`
    );
  } else {
    console.error("Could not find text part in Gemini response:", data);
    throw new Error("Invalid response format from Gemini API.");
  }

  const parsedSubtitles = parseSrt(srtText);

  if (parsedSubtitles.length === 0 && srtText.trim().length > 0) {
    console.warn(
      "SRT parsing yielded no results. The response might not be valid SRT."
    );
  }

  return parsedSubtitles;
}
