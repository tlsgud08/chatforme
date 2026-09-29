export type TurnPriceWarningCurrency = 'USD' | 'KRW';

export interface TurnPriceWarningSettings {
  enabled: boolean;
  currency: TurnPriceWarningCurrency;
  threshold: number;
}

const STORAGE_KEY = 'chatforme.turnPriceWarning';

export const DEFAULT_TURN_PRICE_WARNING: TurnPriceWarningSettings = {
  enabled: false,
  currency: 'KRW',
  threshold: 80,
};

export function loadTurnPriceWarning(): TurnPriceWarningSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<TurnPriceWarningSettings> | null;
    if (!stored) return DEFAULT_TURN_PRICE_WARNING;
    return {
      enabled: stored.enabled === true,
      currency: stored.currency === 'USD' || stored.currency === 'KRW'
        ? stored.currency
        : DEFAULT_TURN_PRICE_WARNING.currency,
      threshold: typeof stored.threshold === 'number' && Number.isFinite(stored.threshold) && stored.threshold >= 0
        ? stored.threshold
        : DEFAULT_TURN_PRICE_WARNING.threshold,
    };
  } catch {
    return DEFAULT_TURN_PRICE_WARNING;
  }
}

export function saveTurnPriceWarning(settings: TurnPriceWarningSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function isTurnPriceWarning(costInUsd: number, settings: TurnPriceWarningSettings, usdKrwRate: number) {
  if (!settings.enabled || settings.threshold < 0) return false;
  const comparableCost = settings.currency === 'KRW' ? costInUsd * usdKrwRate : costInUsd;
  return comparableCost >= settings.threshold;
}
