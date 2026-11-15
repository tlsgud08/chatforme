// The existing extracted-handler/component VMs do not execute module imports.
// Explicitly provide the default provider; real Local routing has separate integration tests.
export const providerFixture = {
  loadLocalPreferences: () => ({ provider: 'openrouter', model: '', topP: null }),
  localModelFor: () => '',
  summaryProviderFor: () => 'openrouter',
  SummaryProviderSelect: 'SummaryProviderSelect',
  useLocalProvider: () => ({ provider: 'openrouter', model: '', userId: 'owner' }),
};
