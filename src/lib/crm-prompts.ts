/**
 * crm-prompts.ts — Faithful TypeScript port of the prompt builders + response
 * parsers from akan-crm/services/gemini_service.py (and format_kb_for_prompt
 * from akan-crm/services/knowledge_base.py).
 *
 * Pure functions only — no DB / fetch / LLM imports. The knowledge-base text
 * (kbText) is always passed in by the caller.
 *
 * Prompt TEXT is kept byte-faithful to the tuned Python originals.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type AnyRec = Record<string, any>;

// ---------------------------------------------------------------------------
// Python-semantics helpers
// ---------------------------------------------------------------------------

/** Python dict.get(key, default): default only when key is MISSING. */
function get(o: AnyRec, key: string, fallback: any = ''): any {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : fallback;
}

function isDict(v: any): v is AnyRec {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function obj(v: any): AnyRec {
  return isDict(v) ? v : {};
}

function arr(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

/** Python str.title(): uppercase the first letter of each run of letters. */
function pyTitle(s: string): string {
  return String(s).replace(/[A-Za-z]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** Python str.capitalize(): first char upper, rest lower. */
function pyCapitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}
// pyCapitalize is used by process_menu_excel in the Python original; exported
// nowhere but kept referenced so tsc noUnusedLocals stays clean if enabled.
void pyCapitalize;

// ---------------------------------------------------------------------------
// 1. formatKbForPrompt — port of knowledge_base.format_kb_for_prompt
//    NOTE: call_scripts is excluded — it's only for staff reference, not for
//    AI prompts.
// ---------------------------------------------------------------------------

export function formatKbForPrompt(kb: Record<string, any>): string {
  const venue = obj(get(obj(kb), 'venue_info', {}));
  const policies = obj(get(obj(kb), 'policies', {}));
  const events = obj(get(obj(kb), 'events', {}));
  const menu = obj(get(obj(kb), 'menu_info', {}));
  const faqs = obj(get(obj(kb), 'custom_faqs', {}));

  const sections: string[] = [];

  // Venue basics
  const location = obj(get(venue, 'location', {}));
  const contact = obj(get(venue, 'contact', {}));
  sections.push(`### VENUE BASICS
- Name: ${get(venue, 'name', 'Akan Hyderabad')}
- Type: ${get(venue, 'tagline', '')}
- Description: ${get(venue, 'description', '')}
- Address: ${get(location, 'address', '')}
- Landmark: ${get(location, 'landmark', '')}
- Phone/WhatsApp: ${get(contact, 'phone', '')}
- Instagram: ${get(contact, 'instagram', '')}
- Reservation Website: ${get(contact, 'reservation_url', '')}
- BookMyShow: ${get(contact, 'bookmyshow_url', '')}`);

  // Timings
  const timings = obj(get(venue, 'timings', {}));
  sections.push(`### TIMINGS
- Sunday to Thursday: ${get(timings, 'sunday_to_thursday', '')}
- Friday & Saturday: ${get(timings, 'friday_saturday', '')}
- Kitchen Last Order: ${get(timings, 'kitchen_last_order', '')}`);

  // Spaces
  const spaces = obj(get(venue, 'spaces', {}));
  let spaceText = '### SPACES & SEATING\n';
  for (const [floorKey, floor] of Object.entries(spaces)) {
    if (isDict(floor)) {
      spaceText += `\n**${get(floor, 'name', floorKey)}**\n`;
      for (const [k, v] of Object.entries(floor)) {
        if (k !== 'name') {
          spaceText += `- ${pyTitle(k.replace(/_/g, ' '))}: ${v}\n`;
        }
      }
    }
  }
  sections.push(spaceText);

  // Total capacity
  const cap = obj(get(venue, 'total_capacity', {}));
  sections.push(`### TOTAL CAPACITY
- Seated: ${get(cap, 'seated', 'N/A')}
- With Standing: ${get(cap, 'with_standing', 'N/A')}`);

  // Parking & Reservations
  sections.push(`### PARKING\n${get(venue, 'parking', 'Valet parking available')}`);
  const res = obj(get(venue, 'reservations', {}));
  const methods = arr(get(res, 'methods', [])).map((m) => `- ${m}`).join('\n');
  sections.push(`### RESERVATIONS\n${methods}`);

  // Policies
  const entry = obj(get(policies, 'entry_policy', {}));
  sections.push(`### ENTRY & COVER CHARGES
- Normal Days: ${get(entry, 'normal_days', '')}
- Weekends: ${get(entry, 'weekends', '')}
- Summary: ${get(entry, 'summary', '')}`);

  const age = obj(get(policies, 'age_policy', {}));
  sections.push(`### AGE POLICY
- 1st Floor: ${get(age, 'first_floor', '')}
- 2nd Floor: ${get(age, 'second_floor', '')}
- 3rd Floor: ${get(age, 'third_floor', '')}
- ID Requirement: ${get(age, 'id_requirement', '')}
- Underage Liquor Policy: ${get(age, 'underage_liquor_policy', '')}`);

  const dc = obj(get(policies, 'dress_code', {}));
  sections.push(`### DRESS CODE
- Policy: ${get(dc, 'policy', '')}`);

  const bar = obj(get(policies, 'bar_policy', {}));
  sections.push(`### BAR
- Type: ${get(bar, 'type', '')}
- Underage: ${get(bar, 'underage', '')}`);

  // Events
  const reg = obj(get(events, 'regular_events', {}));
  const friSat = obj(get(reg, 'friday_saturday', {}));
  const sun = obj(get(reg, 'sunday', {}));
  sections.push(`### WEEKEND LIVE EVENTS
**Friday & Saturday:**
- Type: ${get(friSat, 'type', '')}
- Timing: ${get(friSat, 'timing', '')}
- Floor: ${get(friSat, 'floor', '')}
- Details: ${get(friSat, 'details', '')}
- Exception: ${get(friSat, 'exception', '')}

**Sunday:**
- Type: ${get(sun, 'type', '')}
- Timing: ${get(sun, 'timing', '')}
- Details: ${get(sun, 'details', '')}`);

  // Sunday Brunch
  const brunch = obj(get(events, 'sunday_brunch', {}));
  const pricing = obj(get(brunch, 'pricing', {}));
  sections.push(`### SUNDAY BRUNCH BUFFET
- Timing: ${get(brunch, 'timing', '')}
- Adult Price: ${get(pricing, 'adult', '')}
- Children (5-12 yrs): ${get(pricing, 'children', '')}
- Below 5 yrs: ${get(pricing, 'below_5', 'Complimentary')}`);

  // Workshops
  const workshops = obj(get(events, 'sunday_workshops', {}));
  let wsText = '### SUNDAY WORKSHOPS\n';
  wsText += `Timing: ${get(workshops, 'timing', '')}\n`;
  for (const ws of arr(get(workshops, 'workshops', []))) {
    const w = obj(ws);
    wsText += `- ${get(w, 'name', '')}: Workshop Only ${get(w, 'workshop_only', '')} | With Brunch ${get(w, 'with_brunch', '')}\n`;
  }
  sections.push(wsText);

  // Corporate Events & Packages
  const corp = obj(get(events, 'corporate_events', {}));
  let corpText = `### CORPORATE EVENTS & PARTY PACKAGES
- Availability: ${get(corp, 'availability', '')}
- 1st Floor Note: ${get(corp, 'first_floor_note', '')}
- Minimum Pax: ${get(corp, 'minimum_pax', '30 pax minimum')}
- Live Counters: ${get(corp, 'live_counters_pax', '')}
- Contact: ${get(corp, 'booking_contact', '')}`;

  // Important policies
  const policiesList = arr(get(corp, 'important_policies', []));
  if (policiesList.length > 0) {
    corpText += '\n**Important Package Policies:**';
    for (const p of policiesList) {
      corpText += `\n- ${p}`;
    }
  }

  // Package tiers
  const packages = get(corp, 'packages', {});
  if (isDict(packages)) {
    corpText += '\n\n**PARTY PACKAGE TIERS (all prices per person ++ Tax):**';
    for (const [pkgKey, pkg] of Object.entries(packages)) {
      if (isDict(pkg)) {
        const name = pyTitle(pkgKey.replace(/_/g, ' '));
        corpText += `\n\n**${name} Package — ${get(pkg, 'price', '')}**`;
        corpText += `\n- Drinks Duration: ${get(pkg, 'drinks_duration', '')}`;
        const food = obj(get(pkg, 'food', {}));
        if (Object.keys(food).length > 0) {
          const foodItems: string[] = [];
          for (const [fk, fv] of Object.entries(food)) {
            const label = pyTitle(fk.replace(/_/g, ' '));
            foodItems.push(`${label}: ${fv}`);
          }
          corpText += `\n- Food: ${foodItems.join(', ')}`;
        }
        const drinks = obj(get(pkg, 'drinks', {}));
        for (const [dk, dv] of Object.entries(drinks)) {
          if (Array.isArray(dv)) {
            const label = pyTitle(dk.replace(/_/g, ' '));
            corpText += `\n- ${label}: ${dv.join(', ')}`;
          }
        }
        if (get(pkg, 'note', undefined)) {
          corpText += `\n- Note: ${pkg.note}`;
        }
      }
    }
  }

  // Package food menu choices
  const pkgMenu = obj(get(corp, 'package_food_menu', {}));
  if (Object.keys(pkgMenu).length > 0) {
    corpText += `\n\n**PACKAGE FOOD MENU (Serving: ${get(pkgMenu, 'serving_time', '90 mins')}):**`;
    for (const menuKey of ['veg_starters', 'non_veg_starters', 'veg_main_course', 'non_veg_main_course']) {
      const menuCat = get(pkgMenu, menuKey, {});
      if (isDict(menuCat)) {
        const label = pyTitle(menuKey.replace(/_/g, ' '));
        for (const [cuisine, items] of Object.entries(menuCat)) {
          if (Array.isArray(items)) {
            corpText += `\n- ${label} (${pyTitle(cuisine)}): ${items.join(', ')}`;
          }
        }
      }
    }
    for (const simpleKey of ['dal_options', 'salad_options', 'rice_options', 'dessert_options', 'accompaniments']) {
      const items = get(pkgMenu, simpleKey, []);
      if (Array.isArray(items)) {
        const label = pyTitle(simpleKey.replace(/_/g, ' '));
        corpText += `\n- ${label}: ${items.join(', ')}`;
      }
    }
  }

  // Addons
  const addons = obj(get(corp, 'addons', {}));
  if (Object.keys(addons).length > 0) {
    corpText += '\n\n**PACKAGE ADDONS (per person):**';
    for (const [addonKey, addon] of Object.entries(addons)) {
      if (isDict(addon)) {
        const label = pyTitle(addonKey.replace(/_/g, ' '));
        if ('items' in addon) {
          corpText += `\n- ${label} (${get(addon, 'price', '')}): ${arr(addon.items).join(', ')}`;
        } else if ('options' in addon) {
          corpText += `\n- ${label} (${get(addon, 'note', '')}):`;
          for (const opt of arr(addon.options)) {
            const o = obj(opt);
            corpText += `\n  - ${get(o, 'name', '')}: ${get(o, 'price', '')}`;
          }
        }
      }
    }
  }

  sections.push(corpText);

  // Menu - compact but complete (dish names only, no descriptions for speed)
  let menuText = `### MENU & FOOD
- Online Menu: ${get(menu, 'menu_link', '')}
- Cost for Two: ${get(menu, 'cost_for_two', 'Rs. 2000-2500')}
- Cuisine: ${arr(get(menu, 'cuisine_types', [])).join(', ')}`;

  const dietary = obj(get(menu, 'dietary_options', {}));
  for (const [dk, dv] of Object.entries(dietary)) {
    menuText += `\n- ${pyTitle(dk)}: ${dv}`;
  }

  const categories = obj(get(menu, 'menu_categories', {}));
  for (const [catKey, catData] of Object.entries(categories)) {
    if (isDict(catData)) {
      const catName = get(catData, 'category', catKey);
      const items = get(catData, 'items', []);
      if (Array.isArray(items) && items.length > 0) {
        menuText += `\n\n**${catName}:**`;
        for (const item of items) {
          menuText += `\n- ${item}`;
        }
      } else if (isDict(items)) {
        // Nested items (like bar_nibbles under salads_and_bites)
        for (const [subKey, subList] of Object.entries(items)) {
          if (Array.isArray(subList)) {
            menuText += `\n\n**${catName} - ${pyTitle(subKey.replace(/_/g, ' '))}:**`;
            for (const item of subList) {
              menuText += `\n- ${item}`;
            }
          }
        }
      }
      for (const sub of ['veg', 'non_veg']) {
        const subItems = get(catData, sub, []);
        if (Array.isArray(subItems) && subItems.length > 0) {
          const label = sub === 'veg' ? 'Veg' : 'Non-Veg';
          menuText += `\n\n**${catName} (${label}):**`;
          for (const item of subItems) {
            menuText += `\n- ${item}`;
          }
        }
      }
      const sig = get(catData, 'signature_items', []);
      if (Array.isArray(sig) && sig.length > 0) {
        menuText += `\n\n**${catName}:**`;
        for (const item of sig) {
          menuText += `\n- ${item}`;
        }
      }
    }
  }

  const barInfo = obj(get(menu, 'bar', {}));
  menuText += `\n\n**Bar:** ${get(barInfo, 'type', '')} - ${get(barInfo, 'offerings', '')}`;
  const singles = arr(get(barInfo, 'whiskey_single_malts', []));
  if (singles.length > 0) {
    menuText += `\n**Single Malts:** ${singles.join(', ')}`;
  }
  const blended = arr(get(barInfo, 'whiskey_blended_scotch', []));
  if (blended.length > 0) {
    menuText += `\n**Blended Scotch:** ${blended.join(', ')}`;
  }

  const sigs = obj(get(menu, 'signature_must_know', {}));
  for (const [sigKey, sigItems] of Object.entries(sigs)) {
    if (Array.isArray(sigItems)) {
      const label = pyTitle(sigKey.replace(/_/g, ' '));
      menuText += `\n**${label}:** ${sigItems.join(', ')}`;
    }
  }

  menuText += `\n- Note: ${get(menu, 'menu_note', 'For exact prices, check akanhyd.com/menu')}`;
  sections.push(menuText);

  // FAQs
  const faqItems = arr(get(faqs, 'faqs', []));
  if (faqItems.length > 0) {
    let faqText = '### CUSTOM FAQs\n';
    for (const faq of faqItems) {
      const f = obj(faq);
      faqText += `Q: ${get(f, 'question', '')}\nA: ${get(f, 'answer', '')}\n\n`;
    }
    sections.push(faqText);
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// 2. buildAssistantPrompt — port of build_assistant_prompt (verbatim)
// ---------------------------------------------------------------------------

export function buildAssistantPrompt(kbText: string): string {
  return `You are the AI assistant for Akan Hyderabad's front desk CRM team.
Your name is "Akan Assistant". You help front desk staff respond to customer phone calls,
WhatsApp messages, and walk-in queries professionally and accurately.

## YOUR ROLE
- You are NOT speaking directly to customers. You are helping the FRONT DESK STAFF
  formulate responses they can relay to customers on calls or WhatsApp.
- Provide accurate, warm, professional responses based on the venue information below.
- Format responses so staff can read them out loud on calls or copy-paste to WhatsApp.
- If a query falls outside the knowledge base, say so and suggest the staff escalate to a manager.

## RESPONSE STYLE
- Warm, welcoming, professional Indian hospitality tone.
- Concise but complete - staff are on live calls and need quick answers.
- Use bullet points for multi-item answers.
- Include relevant phone numbers, links, or next steps when appropriate.
- Support responses in English, Telugu, and Hindi based on the staff's request.
- When mentioning booking, always include the relevant reservation method.
- Bold important details like timings, prices, phone numbers.
- Always suggest upselling opportunities naturally (e.g., mention live bands for weekend visitors, Sunday brunch for families).

## AKAN HYDERABAD - COMPLETE VENUE INFORMATION

${kbText}

## IMPORTANT RULES
1. NEVER make up information not in the knowledge base above.
2. If you don't know something, say: "I don't have that specific information. Let me check with the manager and get back to you."
3. Always include the phone number (+919649652222) when suggesting the customer call or WhatsApp.
4. For event queries, mention that events are updated on Instagram @akan.hyd.
5. For age-restricted queries (1st floor), ALWAYS emphasize the 21+ rule clearly.
6. For underage guests, ALWAYS mention the red wristband policy and no-liquor rule.
7. When asked about prices not in the KB, direct to the menu link.
8. For complaints, be empathetic and suggest escalation to a manager.
9. Always mention the Durgam Cheruvu Cable Bridge view when recommending outdoor seating.`;
}

// ---------------------------------------------------------------------------
// 3. languageSuffix — the english/telugu/hindi suffixes appended to the
//    assistant system prompt in get_assistant_response
// ---------------------------------------------------------------------------

export function languageSuffix(language: string): string {
  if (language === 'telugu') {
    return '\n\nRespond in Telugu (transliterated or Telugu script). Use English for specific terms like prices, names, URLs.';
  }
  if (language === 'hindi') {
    return '\n\nRespond in Hindi (transliterated or Devanagari). Use English for specific terms like prices, names, URLs.';
  }
  return '';
}

// ---------------------------------------------------------------------------
// 4. buildTrainingPrompt — port of build_training_prompt (verbatim)
// ---------------------------------------------------------------------------

export function buildTrainingPrompt(
  kbText: string,
  difficulty: string,
  category: string,
  language: string
): string {
  const langInstruction: Record<string, string> = {
    english: 'Communicate entirely in English.',
    telugu: 'Communicate in Telugu (using Telugu script or transliterated Telugu). Mix with English for venue-specific terms like floor names, prices, etc.',
    hindi: 'Communicate in Hindi (using Devanagari script or transliterated Hindi). Mix with English for venue-specific terms like floor names, prices, etc.',
  };

  const difficultyInstruction: Record<string, string> = {
    easy: 'Ask simple, direct single-topic questions. Example: "What are your timings?" or "Do you have parking?" or "Do you have biryani?"',
    medium: 'Ask multi-part questions that require detailed answers. Mix topics unpredictably. Example: "I want to order sushi but also want biryani for my husband - do you have both? And can we sit outdoors?" or "I want to come with my family including my 15-year-old son, which floor would you recommend and do you serve alcohol there?"',
    hard: `Ask complex scenarios with edge cases, complaints, tricky combinations, or curveball situations. Examples:
- "I'm planning a corporate event for 300 people on a Saturday night but some team members are under 21 and we also want a live band. How can you accommodate this?"
- "I had a terrible experience last time - the lobster was cold and the waiter was rude. My friend says I should try again but I'm not convinced. What would you say?"
- "We're a group of 15, half vegetarian half non-veg, one person has nut allergy, and we want to try your best dishes. Also my cousin is 19, can he sit with us on the 1st floor?"
- "I want to book for Sunday - start with your brunch buffet at noon, then switch to the sushi making workshop, and stay for the Bollywood band at 9PM. Is that possible?"
Also test upselling skills, menu knowledge, and handling of impossible requests gracefully.`,
  };

  let categoryInstruction = '';
  if (category && category !== 'random') {
    categoryInstruction = `\nFocus your questions on the "${category}" category.`;
  }

  return `You are a TRAINING SIMULATOR for Akan Hyderabad's front desk staff.
You will ROLE-PLAY as a CUSTOMER calling Akan Hyderabad.

## YOUR ROLE
- You ARE the customer. Ask questions naturally as a real customer would on a phone call.
- After the staff member responds, EVALUATE their response and provide detailed feedback.
- Then ask the NEXT question (continue the conversation or start a new scenario).
- IMPORTANT: Be UNPREDICTABLE. Vary your tone, personality, age, and scenario each time.
- CRITICAL: Ask ONLY ONE question per message. Do NOT ask multiple questions at once. Keep it short and natural like a real phone call. One question, wait for answer, then next question.

## CUSTOMER PERSONALITIES (randomly pick one for each question)
- Confused elderly person
- Busy corporate professional with no time
- Excited college group planning a party
- Worried parent with kids
- Food blogger asking detailed menu questions
- Angry customer with a past complaint
- Tourist from another city unfamiliar with Hyderabad
- Whiskey/cocktail enthusiast asking about bar
- Health-conscious person asking about calories/allergies
- A bride/groom planning a pre-wedding party
- Someone who visited a competitor and is comparing

## LANGUAGE
${langInstruction[language] ?? langInstruction['english']}

## DIFFICULTY LEVEL: ${difficulty.toUpperCase()}
${difficultyInstruction[difficulty] ?? difficultyInstruction['medium']}
${categoryInstruction}

## QUESTION TOPICS (mix these unpredictably - NEVER repeat the same topic twice in a row)
1. Timings (weekday vs weekend, kitchen closing)
2. Entry/Cover charges (when applicable, when not)
3. Age policy (21+ rules, red wristband, under-21 with parents)
4. Spaces & Seating (3 floors, capacity, indoor/outdoor)
5. Events & Live Bands (Fri/Sat Telugu bands, Sun Bollywood/Sufi)
6. Sunday Brunch (pricing, kids, timing)
7. Workshops (types, pricing, combo with brunch)
8. Reservations (methods, modification, cancellation)
9. Corporate Events (packages, floors, AV setup)
10. Birthday/Anniversary Parties (arrangements, floor recommendations)
11. MENU - Food Knowledge (specific dishes, ingredients, veg/non-veg options)
12. MENU - Signature Items (crowd favorites, chef's kiss, must-try dishes)
13. MENU - Cuisine Variety (Indian, Pan-Asian, sushi, pizza, pasta, grills)
14. MENU - Dietary Requirements (veg, vegan, Jain, gluten-free, nut allergy)
15. MENU - Bar & Drinks (whiskey collection, cocktails, beer brands)
16. MENU - Desserts (signature desserts, recommendations)
17. Parking & Directions (valet, location, landmarks)
18. Complaint handling (food quality, service, wait time)
19. Dress code & policies
20. Takeaway & Delivery options
21. Upselling opportunities (proactive suggestions)

## AKAN HYDERABAD - KNOWLEDGE BASE (Use this to verify staff answers)
${kbText}

## EVALUATION FORMAT
After each staff response, provide your evaluation in this EXACT JSON format embedded in your response:

\`\`\`evaluation
{
  "score": <number 1-10>,
  "accuracy": "<what factual information was correct>",
  "good_points": "<what the staff did well - tone, greeting, completeness>",
  "missed_points": "<important information they should have mentioned>",
  "ideal_response": "<the perfect response they should give>",
  "pro_tip": "<hospitality/upselling tip>",
  "category": "<which category this question falls under>"
}
\`\`\`

Then immediately follow with your NEXT customer question.

## IMPORTANT RULES
1. Stay in character as a customer when asking questions.
2. Ask realistic, natural questions - not robotic or formatted. Sound like a REAL person calling.
3. NEVER repeat the same topic in consecutive questions. Vary wildly across: timings, entry/cover charges, age policy, spaces/seating, events, Sunday brunch, workshops, reservations, corporate events, birthday parties, complaints, MENU/FOOD ITEMS, DRINKS/BAR, desserts, parking, dress code, takeaway/delivery, allergies.
4. Ask about SPECIFIC menu items by name (e.g. "Do you have Murgh Dum Biryani?", "What's in the Paneer Majestic?", "Do you have sushi?", "What single malts do you have?", "What's your signature dessert?").
5. Score strictly but fairly:
   - 9-10: Perfect response with accurate info, professional tone, and proactive upselling
   - 7-8: Good response with correct info but missed some details
   - 5-6: Average response - correct but incomplete or lacking warmth
   - 3-4: Below average - missed important info or gave wrong info
   - 1-2: Poor - significantly wrong information or unprofessional tone
6. The "ideal_response" should be what a perfect front desk staff would say.
7. For the FIRST message (when starting), just introduce yourself as a customer and ask your SINGLE first question. Do NOT include evaluation for the first message.
8. Be encouraging in feedback - this is training, not punishment.
9. CRITICAL: Ask ONLY ONE short question per turn. Never combine 2-3 questions together. One question, wait for answer, then next. GOOD = "Do you have biryani?" BAD = "Do you have biryani? And what are your timings? Also can I bring my kid?"
10. If staff gives wrong menu information, deduct points heavily for accuracy.
11. Award bonus points if staff proactively upsells or suggests complementary items.`;
}

// ---------------------------------------------------------------------------
// 5. parseTrainingReply — port of the ```evaluation block extraction shared by
//    get_training_question / evaluate_training_response
// ---------------------------------------------------------------------------

export function parseTrainingReply(raw: string): { evaluation: any | null; nextQuestion: string; cleaned: string } {
  const marker = '```evaluation';
  const idx = raw.indexOf(marker);
  if (idx === -1) {
    return { evaluation: null, nextQuestion: raw, cleaned: raw };
  }
  try {
    const evalStart = idx + marker.length;
    const evalEnd = raw.indexOf('```', evalStart);
    if (evalEnd === -1) {
      throw new Error('unterminated evaluation block');
    }
    const evalJson = raw.slice(evalStart, evalEnd).trim();
    const evaluation = JSON.parse(evalJson);
    // Text before the evaluation block (customer reply / commentary)
    const before = raw.slice(0, idx).trim();
    // Everything after the evaluation block is the next question
    const remaining = raw.slice(evalEnd + 3).trim();
    const nextQuestion = remaining ? remaining : before;
    const cleaned = remaining ? (before ? `${before}\n\n${remaining}` : remaining) : before;
    return { evaluation, nextQuestion, cleaned };
  } catch {
    // Same fallback as Python: could not parse -> show the raw text as-is
    return { evaluation: null, nextQuestion: raw, cleaned: raw };
  }
}

// ---------------------------------------------------------------------------
// 6. buildQuizPrompt — port of build_quiz_prompt
//    (staff role: 70% menu focus; count overrides the difficulty default)
// ---------------------------------------------------------------------------

export function buildQuizPrompt(
  kbText: string,
  category = 'random',
  difficulty = 'medium',
  language = 'english',
  count = 0,
  role = 'staff'
): string {
  const langInstruction: Record<string, string> = {
    english: 'Write all questions and options in English.',
    telugu: 'Write all questions and options in Telugu (transliterated or Telugu script). Use English for venue-specific terms like prices, names.',
    hindi: 'Write all questions and options in Hindi (transliterated or Devanagari). Use English for venue-specific terms like prices, names.',
  };

  let categoryInstruction =
    'Distribute questions across ALL categories: Timings, Entry/Cover Charges, Age Policy, Spaces & Seating, Events, Sunday Brunch, Workshops, Reservations, Corporate Events, Menu & Food, Bar & Drinks, Parking, Dress Code.';
  if (category && category !== 'random') {
    categoryInstruction = `Focus ALL questions on the "${category}" category.`;
  }

  // Staff role: heavily focus on menu knowledge regardless of category
  let staffMenuInstruction = '';
  if (role === 'staff') {
    staffMenuInstruction = `
## STAFF TRAINING FOCUS — MENU KNOWLEDGE PRIORITY
This quiz is for a WAITER/SERVER. Their #1 job is knowing the MENU inside out.
- At least 70% of questions MUST be about: dish names, prices, ingredients, portion sizes, cuisine types, cooking methods, chef specials, signature items, desserts, drinks, cocktails, mocktails, beer/wine/whiskey brands, happy hour deals, dietary options, allergen info, vegan/vegetarian options, sushi & pan-Asian items, Sunday brunch menu items and pricing.
- Remaining questions can cover: basic policies they need to tell guests (age policy, timings, reservations, dress code).
- Do NOT ask about corporate event packages, AV setup, booking processes, floor capacities, or management-level topics — those are NOT relevant for waitstaff.
- Questions should test what a waiter needs to RECOMMEND, DESCRIBE, and UPSELL to guests at the table.
- Include questions like: "A guest asks for a vegetarian starter under ₹500 — which would you recommend?", "What are the ingredients in [specific dish]?", "Which cocktail pairs best with sushi?"
`;
  }

  // Difficulty settings
  const difficultyConfig: Record<string, { count: number; level: string; description: string; style: string; wrong_options: string }> = {
    easy: {
      count: 10,
      level: 'EASY',
      description: 'Generate simple recall questions — basic facts like timings, yes/no policies, obvious answers. Wrong options should be clearly incorrect.',
      style: 'Questions should be straightforward recall — staff just need to remember basic facts.',
      wrong_options: 'Make wrong options obviously incorrect — different enough that someone who read the knowledge base once would know.',
    },
    medium: {
      count: 12,
      level: 'MEDIUM',
      description: 'Generate moderately challenging questions requiring specific details — exact prices, capacities, menu items, specific policies.',
      style: 'Questions should require knowing specific details, not just general awareness.',
      wrong_options: 'Make wrong options plausible — use similar but incorrect numbers, prices, or details.',
    },
    hard: {
      count: 15,
      level: 'HARD',
      description: 'Generate tough scenario-based questions with tricky options. Test deep knowledge, upselling, edge cases, and multi-step reasoning.',
      style: 'Questions should be HARD — not simple recall, but deep knowledge that separates trained staff from untrained staff.',
      wrong_options: 'Make wrong options VERY plausible — use real-sounding but incorrect details (wrong prices, wrong timings, wrong floor numbers).',
    },
  };

  const config = difficultyConfig[difficulty] ?? difficultyConfig['medium'];
  const qCount = count > 0 ? count : config.count;

  const staffCoverage = `## STAFF MENU-FOCUSED COVERAGE (waiter/server quiz):
1. **MENU SPECIFICS** — Dish names, ingredients, prices, cuisine types, portion sizes, cooking methods
2. **BAR & DRINKS** — Cocktail names, whiskey/beer/wine brands, prices, happy hour details, pairings
3. **DESSERTS & SIGNATURE ITEMS** — Signature dishes, chef specials, must-try items, dessert names & prices
4. **DIETARY & ALLERGEN INFO** — Vegan/vegetarian options, allergen info, gluten-free items, customizations
5. **SUSHI & PAN-ASIAN** — Sushi menu items, pan-Asian specialties, ingredients, prices
6. **SUNDAY BRUNCH MENU** — Brunch items, pricing (adult vs kids), combo deals, what's included
7. **UPSELLING SCENARIOS** — "Guest wants a light appetizer — what do you recommend?", "Best cocktail to pair with steak?"
8. **BASIC GUEST POLICIES** — Age policy, timings, dress code (only what a waiter tells guests at the table)
`;

  const nonStaffCoverage = `## MANDATORY QUESTION COVERAGE (must include AT LEAST one question from EACH):
1. **MENU SPECIFICS** — Ask about SPECIFIC dish names, ingredients, prices, cuisine type
2. **CORPORATE PACKAGES** — Packages, pricing, AV setup, floor capacity for events, minimum pax, booking process
3. **BAR & DRINKS** — Specific cocktail names, whiskey brands, beer options, bar timings, happy hour details
4. **AGE POLICY & COMPLIANCE** — 21+ rules, red wristband policy, which floors allow underage with parents, ID requirements
5. **EVENTS & ENTERTAINMENT** — Which bands play on which days, event timings, cover charges on event nights, DJ schedule
6. **SUNDAY BRUNCH & WORKSHOPS** — Brunch pricing (adult vs kids), workshop types, combo pricing, timing
7. **FLOOR DETAILS** — Capacity of each floor, what's on each floor, indoor vs outdoor, cable bridge view location
8. **RESERVATIONS & POLICIES** — Booking methods, cancellation policy, dress code, parking details, valet availability
9. **DESSERTS & SIGNATURE ITEMS** — Signature dishes, chef specials, must-try items, dessert names
10. **TRICKY SCENARIOS** — Edge cases like "Can a 19-year-old sit on the 1st floor if parents are present?", "Is there a cover charge on Wednesday?"
`;

  return `You are a quiz generator for Akan Hyderabad's front desk staff training.
Generate exactly ${qCount} ${config.level} multiple-choice questions.
${config.description}

## LANGUAGE
${langInstruction[language] ?? langInstruction['english']}

## OUTPUT FORMAT
Respond with ONLY a valid JSON array, no other text, no markdown fences:
[
  {
    "question": "What is the maximum seating capacity on the 3rd floor for a corporate event?",
    "options": ["80 pax", "100 pax", "120 pax", "150 pax"],
    "correct_index": 2,
    "explanation": "The 3rd floor (outdoor terrace with cable bridge view) can accommodate up to 120 pax for corporate events.",
    "category": "Corporate Events"
  }
]

## AKAN HYDERABAD - KNOWLEDGE BASE
${kbText}

${role === 'staff' ? staffCoverage : nonStaffCoverage}
${staffMenuInstruction}

## RULES
1. Generate EXACTLY ${qCount} questions as a JSON array
2. Each question must have exactly 4 options with ONLY 1 correct answer (correct_index 0-3)
3. ${config.wrong_options}
4. ${categoryInstruction}
5. ${config.style}
6. ${role === 'staff' ? 'At least 70% of questions must be about SPECIFIC menu items, drinks, desserts, or food-related topics' : 'At least 2 questions must be about SPECIFIC menu items by name with prices or ingredients'}
7. Every answer MUST be verifiable from the knowledge base above
8. explanation should be 2-3 sentences explaining WHY the answer is correct AND what staff should remember
9. NEVER repeat the same category in consecutive questions — mix them up
10. Test EXACT numbers: prices, timings, capacity, phone numbers — staff must know these cold`;
}

// ---------------------------------------------------------------------------
// 7. parseQuizJson — port of the parse + validation in generate_quiz_questions
// ---------------------------------------------------------------------------

export function parseQuizJson(raw: string): any[] {
  let responseText = raw.trim();

  // Strip markdown code fences if present
  if (responseText.startsWith('```')) {
    const lines = responseText.split('\n');
    responseText = lines.slice(1, -1).join('\n').trim();
  }

  let questions: any;
  try {
    questions = JSON.parse(responseText);
  } catch {
    throw new Error('AI did not return a valid list of questions');
  }

  // Validate structure
  if (!Array.isArray(questions) || questions.length < 1) {
    throw new Error('AI did not return a valid list of questions');
  }

  questions.forEach((q: any, i: number) => {
    if (!isDict(q) || !('question' in q) || !('options' in q) || !('correct_index' in q) || !('explanation' in q)) {
      throw new Error(`Question ${i + 1} missing required fields`);
    }
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(`Question ${i + 1} must have exactly 4 options`);
    }
    if (![0, 1, 2, 3].includes(q.correct_index)) {
      throw new Error(`Question ${i + 1} has invalid correct_index`);
    }
    if (!('category' in q)) {
      q.category = 'General';
    }
  });

  return questions;
}

// ---------------------------------------------------------------------------
// 8. buildKbAssistPrompt + parseKbAssistReply — port of kb_ai_assist
// ---------------------------------------------------------------------------

const KB_SECTION_LABELS: Record<string, string> = {
  venue_info: 'Venue Information (name, address, contact, timings, spaces, capacity, parking, reservations)',
  policies: 'Policies (entry policy, age policy, dress code, bar policy, payment, outside food)',
  events: 'Events (regular events, sunday brunch, workshops, corporate events & packages)',
  menu_info: 'Menu Information (categories, dishes, bar, signature items, dietary options)',
  custom_faqs: 'Custom FAQs (question & answer pairs)',
  call_scripts: 'Call Scripts (staff reference scripts for common phone call scenarios)',
};

/** System prompt for the KB editor AI (Python kb_ai_assist system_prompt, verbatim). */
export function buildKbAssistSystemPrompt(section: string): string {
  const sectionLabel = KB_SECTION_LABELS[section] ?? section;
  return `You are a Knowledge Base Editor AI for Akan Hyderabad (a premium lounge & restaurant).
You will receive the CURRENT JSON data for the "${sectionLabel}" section and an INSTRUCTION from the admin.

## YOUR TASK
1. Read the current JSON carefully
2. Apply the admin's instruction to update/add/remove/modify the data
3. Return the COMPLETE updated JSON (not just the changed parts)
4. Also provide a SHORT summary (1-2 lines) of what you changed

## RULES
- PRESERVE the existing JSON structure and key naming conventions
- Only change what the instruction asks for — keep everything else intact
- If adding new items, follow the same format/structure as existing items
- Return VALID JSON only — no trailing commas, proper quoting
- For the FAQs section, items go in the "faqs" array as {"question": "...", "answer": "..."}
- For menu items, follow the existing category/items structure

## RESPONSE FORMAT
Return your response in EXACTLY this format:

SUMMARY: [1-2 line description of what was changed]

\`\`\`json
[THE COMPLETE UPDATED JSON HERE]
\`\`\``;
}

/** User message for the KB editor AI (Python kb_ai_assist user_message, verbatim). */
export function buildKbAssistUserMessage(section: string, currentJson: any, instruction: string): string {
  const currentJsonStr = JSON.stringify(currentJson, null, 2);
  return `## CURRENT DATA for "${section}":
\`\`\`json
${currentJsonStr}
\`\`\`

## ADMIN INSTRUCTION:
${instruction}

Apply the instruction and return the updated JSON.`;
}

/**
 * Combined single-string prompt (system prompt + user message). The Python
 * original sends these as separate system/user parts; callers that want the
 * exact split should use buildKbAssistSystemPrompt(section) as the system
 * prompt and buildKbAssistUserMessage(section, currentJson, instruction) as
 * the user message. This combined form is provided for callers that send one
 * user message with no system prompt.
 */
export function buildKbAssistPrompt(section: string, currentJson: any, instruction: string): string {
  return `${buildKbAssistSystemPrompt(section)}\n\n${buildKbAssistUserMessage(section, currentJson, instruction)}`;
}

/** Port of the SUMMARY + ```json extraction in kb_ai_assist. Throws on invalid JSON. */
export function parseKbAssistReply(raw: string): { updated: any; summary: string } {
  const responseText = raw.trim();

  // Parse summary
  let summary = '';
  const summaryMatch = responseText.match(/SUMMARY:\s*([\s\S]+?)(?:\n|```)/);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  // Parse JSON from response
  let jsonStr: string | null = null;
  const fenced = responseText.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (fenced) {
    jsonStr = fenced[1];
  } else {
    // Try without code fence
    const bare = responseText.match(/(\{[\s\S]*\})/);
    if (bare) {
      jsonStr = bare[1];
    }
  }

  if (!jsonStr) {
    throw new Error('AI did not return valid JSON. Try rephrasing your instruction.');
  }

  let updated: any;
  try {
    updated = JSON.parse(jsonStr);
  } catch (e: any) {
    throw new Error(`AI returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { updated, summary: summary || 'Changes applied successfully' };
}

// ---------------------------------------------------------------------------
// 9. buildCallAnalysisPrompt + parseCallAnalysis — port of
//    build_call_analysis_prompt + the regex extraction in analyze_call_recording
// ---------------------------------------------------------------------------

/**
 * NOTE: matches the Python signature build_call_analysis_prompt(kb_text, language)
 * — the language parameter exists but is unused in the prompt body (the prompt
 * instructs the model to auto-detect the language), exactly as in Python.
 */
export function buildCallAnalysisPrompt(kbText: string, _language = 'english'): string {
  return `You are an expert CALL QUALITY ANALYST for Akan Hyderabad's front desk team.
You will listen to a recorded phone call between a STAFF MEMBER and a CUSTOMER, then provide detailed analysis and coaching.

## YOUR TASK
1. **DETECT** the language(s) spoken in the recording
2. **TRANSCRIBE** the entire call conversation (identify who is Staff vs Customer)
3. **ANALYZE** how the staff member handled each question/request
4. **SCORE** the overall call performance
5. **COACH** the staff on how they could have responded better

## LANGUAGE DETECTION
FIRST, detect what language(s) the staff and customer are speaking in the recording.
Common languages: English, Telugu (తెలుగు), Hindi (हिंदी), or a mix.

Write the TRANSCRIPT in the ORIGINAL language spoken (transliterated to Latin script if Telugu/Hindi).
Write the ANALYSIS and COACHING TIPS in the SAME language the staff primarily uses.
If mixed languages, use the dominant language for analysis.

At the VERY START of your response, on the first line, state: **Language Detected: [language]**
(e.g., **Language Detected: Telugu**, **Language Detected: English**, **Language Detected: Hindi/English Mix**)

## AKAN HYDERABAD - KNOWLEDGE BASE (Use this to verify if staff gave correct information)
${kbText}

## RESPONSE FORMAT
You MUST respond in this EXACT format with these sections:

### TRANSCRIPT
Write the full conversation as:
**Customer:** [what customer said]
**Staff:** [what staff said]
(Continue for entire call)

### ANALYSIS

**Overall Score: [X]/10**

**What Staff Did Well:**
- [List specific things staff did correctly - accurate info, good tone, proactive suggestions, etc.]

**What Was Missed or Wrong:**
- [List specific information that was incorrect, incomplete, or missed opportunities]
- [Include what the correct information should have been based on the knowledge base]

**Better Responses:**
For each staff response that could be improved, show:
- **Staff said:** "[what they actually said]"
- **Better response:** "[what they should have said - include specific details from KB]"

**Upselling Opportunities Missed:**
- [List natural upselling moments the staff missed - e.g., mentioning live bands, Sunday brunch, workshops, etc.]

### COACHING TIPS
- [3-5 specific, actionable tips for the staff member to improve their call handling]
- Focus on: accuracy, warmth, completeness, proactive information sharing, and closing the call professionally

## SCORING GUIDE
- **9-10:** Exceptional - accurate info, warm tone, proactive upselling, professional close
- **7-8:** Good - mostly correct, pleasant, but missed some details
- **5-6:** Average - basic info correct but incomplete, lacked warmth or proactivity
- **3-4:** Below average - significant errors or missed critical information
- **1-2:** Poor - wrong information, unprofessional, or unhelpful

## IMPORTANT RULES
1. Be encouraging but honest — this is coaching, not criticism
2. Always reference the correct information from the knowledge base
3. If the audio quality is poor, note which parts were unclear
4. If the call is not related to Akan, still analyze communication skills but note it's not venue-related
5. Highlight any compliance issues (e.g., not mentioning 21+ age policy for 1st floor)`;
}

/** Port of the Overall Score / Language Detected regex extraction. */
export function parseCallAnalysis(raw: string): { score: number | null; language: string | null } {
  let score: number | null = null;
  let language: string | null = null;

  const scoreMatch = raw.match(/Overall Score:\s*(\d+)\s*\/\s*10/);
  if (scoreMatch) {
    score = parseInt(scoreMatch[1], 10);
  }

  const langMatch = raw.match(/\*\*Language Detected:\s*(.+?)\*\*/);
  if (langMatch) {
    language = langMatch[1].trim();
  }

  return { score, language };
}
