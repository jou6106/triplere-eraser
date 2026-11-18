// Friendly names for Apple model identifiers, and how to put each family into Recovery mode.
const IPHONE = {
  'iPhone8,1': 'iPhone 6s', 'iPhone8,2': 'iPhone 6s Plus', 'iPhone8,4': 'iPhone SE',
  'iPhone9,1': 'iPhone 7', 'iPhone9,3': 'iPhone 7', 'iPhone9,2': 'iPhone 7 Plus', 'iPhone9,4': 'iPhone 7 Plus',
  'iPhone10,1': 'iPhone 8', 'iPhone10,4': 'iPhone 8', 'iPhone10,2': 'iPhone 8 Plus', 'iPhone10,5': 'iPhone 8 Plus',
  'iPhone10,3': 'iPhone X', 'iPhone10,6': 'iPhone X', 'iPhone11,2': 'iPhone XS', 'iPhone11,4': 'iPhone XS Max',
  'iPhone11,6': 'iPhone XS Max', 'iPhone11,8': 'iPhone XR', 'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro',
  'iPhone12,5': 'iPhone 11 Pro Max', 'iPhone12,8': 'iPhone SE (2nd gen)', 'iPhone13,1': 'iPhone 12 mini',
  'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro', 'iPhone13,4': 'iPhone 12 Pro Max',
  'iPhone14,4': 'iPhone 13 mini', 'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,6': 'iPhone SE (3rd gen)', 'iPhone14,7': 'iPhone 14', 'iPhone14,8': 'iPhone 14 Plus',
  'iPhone15,2': 'iPhone 14 Pro', 'iPhone15,3': 'iPhone 14 Pro Max', 'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus',
  'iPhone16,1': 'iPhone 15 Pro', 'iPhone16,2': 'iPhone 15 Pro Max', 'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus',
  'iPhone17,1': 'iPhone 16 Pro', 'iPhone17,2': 'iPhone 16 Pro Max', 'iPhone17,5': 'iPhone 16e',
  'iPhone18,3': 'iPhone 17', 'iPhone18,1': 'iPhone 17 Pro', 'iPhone18,2': 'iPhone 17 Pro Max', 'iPhone18,4': 'iPhone Air',
};
const IPAD = {
  'iPad6,11': 'iPad (5th gen)', 'iPad6,12': 'iPad (5th gen)', 'iPad7,5': 'iPad (6th gen)', 'iPad7,6': 'iPad (6th gen)',
  'iPad7,11': 'iPad (7th gen)', 'iPad7,12': 'iPad (7th gen)', 'iPad11,6': 'iPad (8th gen)', 'iPad11,7': 'iPad (8th gen)',
  'iPad12,1': 'iPad (9th gen)', 'iPad12,2': 'iPad (9th gen)', 'iPad13,18': 'iPad (10th gen)', 'iPad13,19': 'iPad (10th gen)',
  'iPad15,7': 'iPad (A16)', 'iPad15,8': 'iPad (A16)',
  'iPad11,1': 'iPad mini (5th gen)', 'iPad11,2': 'iPad mini (5th gen)', 'iPad14,1': 'iPad mini (6th gen)', 'iPad14,2': 'iPad mini (6th gen)',
  'iPad16,1': 'iPad mini (A17 Pro)', 'iPad16,2': 'iPad mini (A17 Pro)',
  'iPad11,3': 'iPad Air (3rd gen)', 'iPad11,4': 'iPad Air (3rd gen)', 'iPad13,1': 'iPad Air (4th gen)', 'iPad13,2': 'iPad Air (4th gen)',
  'iPad13,16': 'iPad Air (5th gen)', 'iPad13,17': 'iPad Air (5th gen)', 'iPad14,8': 'iPad Air 11" (M2)', 'iPad14,9': 'iPad Air 11" (M2)',
  'iPad14,10': 'iPad Air 13" (M2)', 'iPad14,11': 'iPad Air 13" (M2)',
  'iPad8,1': 'iPad Pro 11"', 'iPad8,2': 'iPad Pro 11"', 'iPad8,3': 'iPad Pro 11"', 'iPad8,4': 'iPad Pro 11"',
  'iPad8,5': 'iPad Pro 12.9"', 'iPad8,6': 'iPad Pro 12.9"', 'iPad8,7': 'iPad Pro 12.9"', 'iPad8,8': 'iPad Pro 12.9"',
  'iPad8,9': 'iPad Pro 11" (2nd gen)', 'iPad8,10': 'iPad Pro 11" (2nd gen)', 'iPad8,11': 'iPad Pro 12.9" (4th gen)', 'iPad8,12': 'iPad Pro 12.9" (4th gen)',
  'iPad13,4': 'iPad Pro 11" (M1)', 'iPad13,5': 'iPad Pro 11" (M1)', 'iPad13,6': 'iPad Pro 11" (M1)', 'iPad13,7': 'iPad Pro 11" (M1)',
  'iPad13,8': 'iPad Pro 12.9" (M1)', 'iPad13,9': 'iPad Pro 12.9" (M1)', 'iPad13,10': 'iPad Pro 12.9" (M1)', 'iPad13,11': 'iPad Pro 12.9" (M1)',
  'iPad14,3': 'iPad Pro 11" (M2)', 'iPad14,4': 'iPad Pro 11" (M2)', 'iPad14,5': 'iPad Pro 12.9" (M2)', 'iPad14,6': 'iPad Pro 12.9" (M2)',
  'iPad16,3': 'iPad Pro 11" (M4)', 'iPad16,4': 'iPad Pro 11" (M4)', 'iPad16,5': 'iPad Pro 13" (M4)', 'iPad16,6': 'iPad Pro 13" (M4)',
};

export function appleName(productType) {
  if (!productType) return '';
  return IPHONE[productType] || IPAD[productType] || (productType.startsWith('iPad') ? 'iPad' : productType.startsWith('iPhone') ? 'iPhone' : productType);
}

export const appleKind = (productType, deviceClass) =>
  (String(productType || '').startsWith('iPad') || deviceClass === 'iPad') ? 'ipad' : 'iphone';

// iPads that still have a Home button (everything else uses the top-button sequence).
const IPAD_HOME_EXTRA = new Set(['iPad11,1', 'iPad11,2', 'iPad11,3', 'iPad11,4', 'iPad11,6', 'iPad11,7', 'iPad12,1', 'iPad12,2']);
const ipadHasHome = (pt) => /^iPad[1-7],/.test(pt) || IPAD_HOME_EXTRA.has(pt);

/** Recovery-mode button steps for the technician (Arabic), by model family. */
export function recoverySteps(productType, kind) {
  const pt = String(productType || '');
  const major = Number((pt.match(/^iPhone(\d+),/) || [])[1] || 0);
  if (kind === 'ipad' || pt.startsWith('iPad')) {
    if (ipadHasHome(pt)) {
      return ['اقفل الآيباد.', 'دوس زرار Home والزرار اللي فوق مع بعض.', 'متسيبهمش لحد ما تظهر شاشة فيها كابل وكمبيوتر.'];
    }
    return ['دوس زرار الصوت اللي جنب الزرار اللي فوق وسيبه بسرعة.', 'دوس زرار الصوت التاني وسيبه بسرعة.',
      'دوس الزرار اللي فوق ومتسيبهوش لحد ما تظهر شاشة فيها كابل وكمبيوتر.'];
  }
  if (major >= 10) {
    return ['دوس رفع الصوت (Volume Up) وسيبه بسرعة.', 'دوس خفض الصوت (Volume Down) وسيبه بسرعة.',
      'دوس زرار الجنب ومتسيبهوش (حتى لو ظهر لوجو Apple) لحد ما تظهر شاشة فيها كابل وكمبيوتر.'];
  }
  if (major === 9) {
    return ['دوس زرار الجنب وخفض الصوت (Volume Down) مع بعض.', 'متسيبهمش لحد ما تظهر شاشة فيها كابل وكمبيوتر.'];
  }
  if (major > 0) {
    return ['دوس زرار Home وزرار القفل مع بعض.', 'متسيبهمش لحد ما تظهر شاشة فيها كابل وكمبيوتر.'];
  }
  return ['آيفون 8 والأحدث: رفع الصوت وسيبه، خفض الصوت وسيبه، وبعدين زرار الجنب لحد ما تظهر شاشة الكابل والكمبيوتر.',
    'آيفون 7: زرار الجنب + خفض الصوت مع بعض لحد ما تظهر الشاشة.',
    'آيفون 6s والأقدم / آيباد بزرار Home: زرار Home + زرار القفل مع بعض لحد ما تظهر الشاشة.'];
}
