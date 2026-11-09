/**
 * VALET strings — English and Hindi. ASSUMPTION A1 (docs/valet/DESIGN.md): the
 * app has no localisation system, so the module keeps its own table, keyed by
 * stable ids a future app-wide system can absorb unchanged. Imports nothing
 * (used by the guest page generator and by client screens).
 *
 * Hindi copy is plain, everyday Hindi a guest or attendant would actually say;
 * it should be read by a native speaker at the venue before go-live (listed as
 * an open item in VALET-BUILD-STATE.md).
 */
export type Lang = 'en' | 'hi';

export const STRINGS = {
  en: {
    title: 'Valet pass',
    your_car: 'Your car',
    tag: 'Tag',
    status: 'Status',
    st_CHECKED_IN: 'Received — being parked', st_PARKING: 'Being parked', st_PARKED: 'Parked safely',
    st_RETRIEVING: 'On its way to the gate', st_READY_AT_GATE: 'Ready at the gate', st_RELOCATING: 'Being moved near the gate',
    st_HOLDING_NEAR_GATE: 'Waiting near the gate',
    get_car: 'Get my car',
    now: 'Now', in5: 'In 5 min', in10: 'In 10 min', later: 'Later…', choose_time: 'Choose a time',
    request_sent: 'Request received', target_note: 'This is a target time, not a guarantee.',
    scheduled_for: 'Booked for', eta: 'Ready in about', minutes: 'min', any_moment: 'Any moment now',
    waiting_staff: 'Waiting for an attendant to start', ahead_one: '1 car ahead of yours', ahead_n: '{n} cars ahead of yours',
    estimate_note: 'Estimate', parking_first: 'Your car is still being parked — we will bring it right after.',
    gate: 'Pickup point', outside: "I'm outside", outside_done: 'The team knows you are outside',
    cancel: 'Cancel request', reschedule: 'Change time', cancel_pending: 'Your change is waiting for the valet team to confirm.',
    change_declined: 'The team is already bringing your car — please speak to the valet desk.',
    at_gate_title: 'Your car is ready', show_code: 'Show this code to the valet', code_refresh: 'New code in',
    holding_title: 'Your car is waiting near the gate', holding_body: 'Tap "Get my car" when you are ready and we will bring it over.',
    help: 'Need help?', help_sent: 'The valet team has been alerted.', call_venue: 'Call the venue',
    no_pass: 'No valet pass on this phone yet.', no_pass_body: 'Hand your keys to the valet, or scan the valet QR at the entrance.',
    checkin_title: 'Valet check-in', plate: 'Number plate', make: 'Make', model: 'Model', colour: 'Colour',
    name_opt: 'Your name (optional)', mobile_opt: 'Mobile (optional)', checkin_go: 'Get my pairing code',
    pair_title: 'Your pairing code', pair_body: 'Show this code to the valet and hand over your keys. Your pass appears here once they confirm.',
    pair_expires: 'Code expires in', pair_expired: 'This code has expired. Please start again.',
    choose_car: 'Choose a car', select_car_note: 'You have more than one car with us — choose one.',
    offline: 'No connection — showing the last update.', updated: 'Updated', lang: 'हिंदी',
    venue_off: 'Valet check-in is not available right now. Please see the valet desk.',
    done_title: 'Handed over', done_body: 'Thank you — drive safely.',
    err_generic: 'Something went wrong. Please try again or ask the valet desk.',
  },
  hi: {
    title: 'वैले पास',
    your_car: 'आपकी गाड़ी',
    tag: 'टैग',
    status: 'स्थिति',
    st_CHECKED_IN: 'मिल गई — पार्क की जा रही है', st_PARKING: 'पार्क की जा रही है', st_PARKED: 'सुरक्षित पार्क है',
    st_RETRIEVING: 'गेट पर लाई जा रही है', st_READY_AT_GATE: 'गेट पर तैयार है', st_RELOCATING: 'गेट के पास ले जाई जा रही है',
    st_HOLDING_NEAR_GATE: 'गेट के पास इंतज़ार में',
    get_car: 'मेरी गाड़ी लाइए',
    now: 'अभी', in5: '5 मिनट में', in10: '10 मिनट में', later: 'बाद में…', choose_time: 'समय चुनें',
    request_sent: 'अनुरोध मिल गया', target_note: 'यह लक्ष्य समय है, पक्का वादा नहीं।',
    scheduled_for: 'बुक किया गया समय', eta: 'लगभग तैयार होगी', minutes: 'मिनट', any_moment: 'बस आने ही वाली है',
    waiting_staff: 'वैले स्टाफ़ के शुरू करने का इंतज़ार', ahead_one: 'आपसे पहले 1 गाड़ी', ahead_n: 'आपसे पहले {n} गाड़ियाँ',
    estimate_note: 'अनुमान', parking_first: 'आपकी गाड़ी अभी पार्क हो रही है — उसके तुरंत बाद लाएँगे।',
    gate: 'पिकअप पॉइंट', outside: 'मैं बाहर हूँ', outside_done: 'टीम को पता है कि आप बाहर हैं',
    cancel: 'अनुरोध रद्द करें', reschedule: 'समय बदलें', cancel_pending: 'आपका बदलाव वैले टीम की पुष्टि का इंतज़ार कर रहा है।',
    change_declined: 'टीम आपकी गाड़ी पहले ही ला रही है — कृपया वैले डेस्क से बात करें।',
    at_gate_title: 'आपकी गाड़ी तैयार है', show_code: 'यह कोड वैले को दिखाएँ', code_refresh: 'नया कोड',
    holding_title: 'आपकी गाड़ी गेट के पास इंतज़ार कर रही है', holding_body: 'तैयार होने पर "मेरी गाड़ी लाइए" दबाएँ, हम ले आएँगे।',
    help: 'मदद चाहिए?', help_sent: 'वैले टीम को सूचना दे दी गई है।', call_venue: 'वेन्यू को कॉल करें',
    no_pass: 'इस फ़ोन पर अभी कोई वैले पास नहीं है।', no_pass_body: 'चाबी वैले को दें, या प्रवेश पर लगा वैले QR स्कैन करें।',
    checkin_title: 'वैले चेक-इन', plate: 'नंबर प्लेट', make: 'कंपनी', model: 'मॉडल', colour: 'रंग',
    name_opt: 'आपका नाम (वैकल्पिक)', mobile_opt: 'मोबाइल (वैकल्पिक)', checkin_go: 'मेरा पेयरिंग कोड दें',
    pair_title: 'आपका पेयरिंग कोड', pair_body: 'यह कोड वैले को दिखाएँ और चाबी दें। उनकी पुष्टि के बाद आपका पास यहाँ दिखेगा।',
    pair_expires: 'कोड की समय-सीमा', pair_expired: 'यह कोड समाप्त हो गया। कृपया फिर से शुरू करें।',
    choose_car: 'गाड़ी चुनें', select_car_note: 'आपकी एक से ज़्यादा गाड़ियाँ हमारे पास हैं — एक चुनें।',
    offline: 'कनेक्शन नहीं है — आख़िरी जानकारी दिख रही है।', updated: 'अपडेट', lang: 'English',
    venue_off: 'वैले चेक-इन अभी उपलब्ध नहीं है। कृपया वैले डेस्क पर आएँ।',
    done_title: 'गाड़ी सौंप दी गई', done_body: 'धन्यवाद — सुरक्षित चलाएँ।',
    err_generic: 'कुछ गड़बड़ हुई। फिर से कोशिश करें या वैले डेस्क से पूछें।',
  },
} as const;

export type StringKey = keyof typeof STRINGS['en'];

export function t(lang: Lang, key: StringKey, vars: Record<string, string | number> = {}): string {
  const s: string = (STRINGS[lang] as Record<string, string>)[key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

/** Staff-screen status labels (attendant + board), both languages. */
export const STAFF_STATE_LABEL: Record<Lang, Record<string, string>> = {
  en: {
    CHECKED_IN: 'Checked in', PARKING: 'Parking', PARKED: 'Parked', RETRIEVING: 'Fetching', READY_AT_GATE: 'At gate',
    RELOCATING: 'Moving to holding', HOLDING_NEAR_GATE: 'In holding', HANDED_OVER: 'Handed over', VOIDED: 'Void',
    SCHEDULED: 'Booked', QUEUED: 'Waiting', ASSIGNED: 'Claimed', IN_PROGRESS: 'Fetching', READY: 'Ready',
    COMPLETED: 'Completed', CANCELLED: 'Cancelled', NO_SHOW: 'No-show',
  },
  hi: {
    CHECKED_IN: 'चेक-इन', PARKING: 'पार्क हो रही', PARKED: 'पार्क है', RETRIEVING: 'लाई जा रही', READY_AT_GATE: 'गेट पर',
    RELOCATING: 'होल्डिंग में ले जा रहे', HOLDING_NEAR_GATE: 'होल्डिंग में', HANDED_OVER: 'सौंप दी', VOIDED: 'रद्द रिकॉर्ड',
    SCHEDULED: 'बुक', QUEUED: 'इंतज़ार', ASSIGNED: 'ली गई', IN_PROGRESS: 'लाई जा रही', READY: 'तैयार',
    COMPLETED: 'पूरा', CANCELLED: 'रद्द', NO_SHOW: 'नहीं आए',
  },
};
