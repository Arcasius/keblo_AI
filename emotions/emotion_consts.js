export const LABELS = ["stress","calm","fatigue","joy","sadness","anger","urgency","focus"];

// In emotion_consts.js
export const BASELINE = {
  stress: 0.05, 
  calm: 0.10,    
  fatigue: 0.05, // Era 0.3! Adesso lo scarto sarà enorme quando sei stanco
  joy: 0.10,
  sadness: 0.05, 
  anger: 0.02, 
  urgency: 0.05, 
  focus: 0.10    
};

export const ALPHAS = { short:0.50, mid:0.12, long:0.04, mean:0.01 };
export const TAU = { short: 20, mid: 180, long: 10080, mean: 43200 };
export const DOMINANT_THRESHOLD = 0.20;
export const NEUTRAL_BAND = 0.06;