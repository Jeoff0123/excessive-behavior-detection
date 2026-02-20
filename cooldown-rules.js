export function stableRuleId(domain) {
  let hash = 0;
  for (let i = 0; i < domain.length; i += 1) {
    hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  }
  return 100000 + (hash % 900000);
}

export function buildCooldownRule(domain, untilEpochMs) {
  const id = stableRuleId(domain);
  const redirectUrl = chrome.runtime.getURL(
    `blocked.html?site=${encodeURIComponent(domain)}&until=${encodeURIComponent(String(untilEpochMs))}`
  );

  return {
    id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { url: redirectUrl }
    },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: ["main_frame"]
    }
  };
}

export async function applyCooldownRule(domain, untilEpochMs) {
  const rule = buildCooldownRule(domain, untilEpochMs);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [stableRuleId(domain)],
    addRules: [rule]
  });
}

export async function removeCooldownRule(domain) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [stableRuleId(domain)]
  });
}
