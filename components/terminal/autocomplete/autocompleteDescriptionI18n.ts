/**
 * zh-CN overlay for bundled Fig autocomplete descriptions.
 * The dictionary is keyed by the exact English description string.
 * Spec objects stay in English; only suggestion copies shown in the popup change.
 */

type DescriptionDictionary = Record<string, string>;

let dictionaryPromise: Promise<DescriptionDictionary> | undefined;

function loadZhCnDescriptions(): Promise<DescriptionDictionary> {
  dictionaryPromise ??= import("./descriptions.zh-CN.json").then((mod) => {
    const loaded = mod as { default?: DescriptionDictionary };
    return loaded.default ?? (mod as unknown as DescriptionDictionary);
  });
  return dictionaryPromise;
}

/**
 * Copy spec-backed suggestions so a zh-CN description overlay cannot leak into
 * the cached spec or into a later query in another locale.
 */
export async function localizeSpecSuggestionDescriptions<T extends { description?: string }>(
  suggestions: readonly T[],
  locale: string | undefined,
): Promise<readonly T[]> {
  if (locale !== "zh-CN" || suggestions.length === 0) return suggestions;

  let dictionary: DescriptionDictionary;
  try {
    dictionary = await loadZhCnDescriptions();
  } catch {
    return suggestions;
  }
  let changed = false;
  const localized = suggestions.map((suggestion) => {
    const description = suggestion.description;
    if (!description) return suggestion;
    const translated = dictionary[description];
    if (!translated) return suggestion;
    changed = true;
    return { ...suggestion, description: translated };
  });
  return changed ? localized : suggestions;
}
