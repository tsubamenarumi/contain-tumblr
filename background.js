 // Param values from https://developer.mozilla.org/Add-ons/WebExtensions/API/contextualIdentities/create
const TUMBLR_CONTAINER_NAME = "Tumblr";
const TUMBLR_CONTAINER_COLOR = "turquoise";
const TUMBLR_CONTAINER_ICON = "briefcase";
const TUMBLR_DOMAINS = ["tumblr.com", "www.tumblr.com", "assets.tumblr.com", "media.tumblr.com", "66.media.tumblr.com","srvcs.tumblr.com", "px.srvcs.tumblr.com", "txmblr.com", "safe.txmblr.com"];

const MAC_ADDON_ID = "@testpilot-containers";

let macAddonEnabled = false;
let tumblrCookieStoreId = null;
let tumblrCookiesCleared = false;

const canceledRequests = {};
const tumblrHostREs = [];

async function isMACAddonEnabled () {
  try {
    const macAddonInfo = await browser.management.get(MAC_ADDON_ID);
    if (macAddonInfo.enabled) {
      return true;
    }
  } catch (e) {
    return false;
  }
  return false;
}

async function setupMACAddonManagementListeners () {
  browser.management.onInstalled.addListener(info => {
    if (info.id === MAC_ADDON_ID) {
      macAddonEnabled = true;
    }
  });
  browser.management.onUninstalled.addListener(info => {
    if (info.id === MAC_ADDON_ID) {
      macAddonEnabled = false;
    }
  })
  browser.management.onEnabled.addListener(info => {
    if (info.id === MAC_ADDON_ID) {
      macAddonEnabled = true;
    }
  })
  browser.management.onDisabled.addListener(info => {
    if (info.id === MAC_ADDON_ID) {
      macAddonEnabled = false;
    }
  })
}

async function getMACAssignment (url) {
  try {
    const assignment = await browser.runtime.sendMessage(MAC_ADDON_ID, {
      method: "getAssignment",
      url
    });
    return assignment;
  } catch (e) {
    return false;
  }
}

function cancelRequest (tab, options) {
  // we decided to cancel the request at this point, register canceled request
  canceledRequests[tab.id] = {
    requestIds: {
      [options.requestId]: true
    },
    urls: {
      [options.url]: true
    }
  };

  // since webRequest onCompleted and onErrorOccurred are not 100% reliable
  // we register a timer here to cleanup canceled requests, just to make sure we don't
  // end up in a situation where certain urls in a tab.id stay canceled
  setTimeout(() => {
    if (canceledRequests[tab.id]) {
      delete canceledRequests[tab.id];
    }
  }, 2000);
}

function shouldCancelEarly (tab, options) {
  // we decided to cancel the request at this point
  if (!canceledRequests[tab.id]) {
    cancelRequest(tab, options);
  } else {
    let cancelEarly = false;
    if (canceledRequests[tab.id].requestIds[options.requestId] ||
        canceledRequests[tab.id].urls[options.url]) {
      // same requestId or url from the same tab
      // this is a redirect that we have to cancel early to prevent opening two tabs
      cancelEarly = true;
    }
    // register this requestId and url as canceled too
    canceledRequests[tab.id].requestIds[options.requestId] = true;
    canceledRequests[tab.id].urls[options.url] = true;
    if (cancelEarly) {
      return true;
    }
  }
  return false;
}

function generateTumblrHostREs () {
  for (let tumblrDomain of TUMBLR_DOMAINS) {
    tumblrHostREs.push(new RegExp(`^(.*\\.)?${tumblrDomain}$`));
  }
}

async function clearTumblrCookies () {
  // Clear all Tumblr cookies
  const containers = await browser.contextualIdentities.query({});
  containers.push({
    cookieStoreId: 'firefox-default'
  });
  containers.map(container => {
    const storeId = container.cookieStoreId;
    if (storeId === tumblrCookieStoreId) {
      // Don't clear cookies in the Tumblr Container
      return;
    }

    TUMBLR_DOMAINS.map(async tumblrDomain => {
      const tumblrCookieUrl = `https://${tumblrDomain}/`;

      const cookies = await browser.cookies.getAll({
        domain: tumblrDomain,
        storeId
      });

      cookies.map(cookie => {
        browser.cookies.remove({
          name: cookie.name,
          url: tumblrCookieUrl,
          storeId
        });
      });
    });
  });
}

async function setupContainer () {
  // Use existing Tumblr container, or create one
  const contexts = await browser.contextualIdentities.query({name: TUMBLR_CONTAINER_NAME})
  if (contexts.length > 0) {
    tumblrCookieStoreId = contexts[0].cookieStoreId;
  } else {
    const context = await browser.contextualIdentities.create({
      name: TUMBLR_CONTAINER_NAME,
      color: TUMBLR_CONTAINER_COLOR,
      icon: TUMBLR_CONTAINER_ICON
    })
    tumblrCookieStoreId = context.cookieStoreId;
  }
}

async function containTumblr (options) {
  // Listen to requests and open Tumblr into its Container,
  // open other sites into the default tab context
  const requestUrl = new URL(options.url);

  let isTumblr = false;
  for (let tumblrHostRE of tumblrHostREs) {
    if (tumblrHostRE.test(requestUrl.host)) {
      isTumblr = true;
      break;
    }
  }

  // We have to check with every request if the requested URL is assigned with MAC
  // because the user can assign URLs at any given time (needs MAC Events)
  if (macAddonEnabled) {
    const macAssigned = await getMACAssignment(options.url);
    if (macAssigned) {
      // This URL is assigned with MAC, so we don't handle this request
      return;
    }
  }

  const tab = await browser.tabs.get(options.tabId);
  const tabCookieStoreId = tab.cookieStoreId;
  if (isTumblr) {
    if (tabCookieStoreId !== tumblrCookieStoreId && !tab.incognito) {
      if (tumblrCookieStoreId) {
        if (shouldCancelEarly(tab, options)) {
          return {cancel: true};
        }
        browser.tabs.create({
          url: requestUrl.toString(),
          cookieStoreId: tumblrCookieStoreId,
          active: tab.active,
          index: tab.index,
          windowId: tab.windowId
        });
        browser.tabs.remove(options.tabId);
        return {cancel: true};
      }
    }
  } else {
    if (tabCookieStoreId === tumblrCookieStoreId) {
      if (shouldCancelEarly(tab, options)) {
        return {cancel: true};
      }
      browser.tabs.create({
        url: requestUrl.toString(),
        active: tab.active,
        index: tab.index,
        windowId: tab.windowId
      });
      browser.tabs.remove(options.tabId);
      return {cancel: true};
    }
  }
}

(async function init() {
  await setupMACAddonManagementListeners();
  macAddonEnabled = await isMACAddonEnabled();

  await setupContainer();
  clearTumblrCookies();
  generateTumblrHostREs();

  // Add the request listener
  browser.webRequest.onBeforeRequest.addListener(containTumblr, {urls: ["<all_urls>"], types: ["main_frame"]}, ["blocking"]);

  // Clean up canceled requests
  browser.webRequest.onCompleted.addListener((options) => {
    if (canceledRequests[options.tabId]) {
     delete canceledRequests[options.tabId];
    }
  },{urls: ["<all_urls>"], types: ["main_frame"]});
  browser.webRequest.onErrorOccurred.addListener((options) => {
    if (canceledRequests[options.tabId]) {
      delete canceledRequests[options.tabId];
    }
  },{urls: ["<all_urls>"], types: ["main_frame"]});
})();
