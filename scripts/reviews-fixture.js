#!/usr/bin/env node
/**
 * GOOGLE REVIEWS — THE FIXTURE SET.
 *
 *   node scripts/reviews-fixture.js            # print a summary
 *   node scripts/reviews-fixture.js --write DIR  # dump the files for a page demo
 *
 * Three things live here, and they have different jobs.
 *
 *   1. HAND MONTH (13 reviews, March-April 2026). Small enough that every
 *      figure it produces was worked out on paper first. scripts/reviews-tests.js
 *      asserts those hand numbers against the shipped functions, which is the
 *      only way to catch an analysis function that is self-consistently wrong.
 *      DO NOT "tidy" these rows — each one is carrying a specific case, listed
 *      in the comment beside it, and the expected figures in the test are
 *      computed from exactly this set.
 *
 *   2. BULK (about 400 reviews across 14 months). Deterministic — a seeded
 *      PRNG, no Date.now(), no randomness — so a failing run is reproducible.
 *      It carries the shape of a real venue: mostly 4s and 5s, a bad patch in
 *      one month, replies on some but not all, anonymous reviewers, rating-only
 *      reviews, Telugu/Hindi/emoji text, and a burst weekend.
 *
 *   3. EDGE CASES. The rows that break parsers: quoted commas and newlines
 *      inside review text, a rating of "FIVE", a rating of 4.3 (an average that
 *      leaked into a per-review column), STAR_RATING_UNSPECIFIED, a relative
 *      date, an anonymous "A Google user", a review posted at 02:00 IST, and a
 *      reply timestamped before its review.
 *
 * A fixture that only contains rows the parser already handles proves nothing,
 * which is why group 3 exists and why the test asserts they are REFUSED rather
 * than quietly absorbed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ── deterministic PRNG (mulberry32) ─────────────────────────────────────── */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IST_OFFSET_MIN = 330;
/** IST civil clock -> the RFC 3339 UTC string Google would have written. */
function ist(y, m, d, hh = 0, mi = 0, ss = 0) {
  const ms = Date.UTC(y, m - 1, d, hh, mi, ss) - IST_OFFSET_MIN * 60000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function addHours(iso, h) {
  return new Date(Date.parse(iso) + h * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A v4-shaped review object, which is what both the API and a Takeout export
 *  look like. The parser is fed this exact shape so the test exercises the real
 *  nesting (reviewer.displayName, reviewReply.comment) rather than a flat mock. */
function v4(o) {
  const r = {
    reviewId: o.id,
    reviewer: { displayName: o.author ?? 'A Google user', isAnonymous: !o.author },
    starRating: ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'][o.rating],
    createTime: o.createTime,
    updateTime: o.updateTime || o.createTime,
  };
  if (o.text) r.comment = o.text;
  if (o.reply) {
    r.reviewReply = { comment: o.reply };
    if (o.replyAt) r.reviewReply.updateTime = o.replyAt;
  }
  if (o.language) r.languageCode = o.language;
  return r;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. HAND MONTH — every figure in the test was computed from these rows first.
 * ══════════════════════════════════════════════════════════════════════════ */

const LONG_450 = (
  'We came in for a Saturday dinner with six people and the evening did not go well. ' +
  'The starters arrived after forty minutes and two of them were cold by the time they ' +
  'reached the table. We asked twice and nobody came back to us. The main course was ' +
  'better but by then the mood was gone and the children were restless. The bill also ' +
  'had a charge nobody explained to us at any point during the meal itself. Genuinely ' +
  'disappointed because we have been coming here for three years now and it used to be much better.'
);

const LONG_500 = (
  'Easily one of the best evenings we have had out this year. We booked for an ' +
  'anniversary and the team had put a small card on the table without us asking, which ' +
  'my wife noticed immediately. The kebabs were exceptional, properly smoky, and the ' +
  'biryani had that separate grain you almost never get outside a home kitchen. The live ' +
  'band started at nine and the volume was judged well enough that we could still talk ' +
  'across the table. Service was attentive without hovering. Parking was the only ' +
  'slightly awkward part, the valet took a while at the end, but honestly for an evening ' +
  'of this quality that is nothing to complain about. We will be back next month for sure.'
);

const HAND_MONTH = [
  //  1  5 stars, replied 24h later
  v4({ id: 'H01', author: 'Ramesh Kumar', rating: 5, text: 'Great food', language: 'en',
       createTime: ist(2026, 3, 2, 13, 0), reply: 'Thank you Ramesh!', replyAt: ist(2026, 3, 3, 13, 0) }),
  //  2  4 stars, never replied — becomes the oldest unanswered
  v4({ id: 'H02', author: 'Sneha P', rating: 4, text: 'Nice place, will come again',
       createTime: ist(2026, 3, 2, 20, 30) }),
  //  3  1 star AND long AND unanswered — the highest-scoring MAJOR shape
  v4({ id: 'H03', author: 'Arun Reddy', rating: 1, text: LONG_450, createTime: ist(2026, 3, 5, 19, 0) }),
  //  4  2 stars, replied 12h later
  v4({ id: 'H04', author: 'Fatima S', rating: 2, text: 'Service was slow',
       createTime: ist(2026, 3, 5, 21, 0), reply: 'Sorry about this.', replyAt: ist(2026, 3, 6, 9, 0) }),
  //  5  5 stars, short, unanswered — must NOT be major
  v4({ id: 'H05', author: 'Vikram', rating: 5, text: 'Superb', createTime: ist(2026, 3, 9, 12, 0) }),
  //  6  3 stars, unanswered — major only because a reply is owed
  v4({ id: 'H06', author: 'Deepa N', rating: 3, text: 'Average, expected better',
       createTime: ist(2026, 3, 11, 22, 0) }),
  //  7  5 stars AND long AND unanswered — a missed thank-you, NOT major
  v4({ id: 'H07', author: 'Karthik M', rating: 5, text: LONG_500, createTime: ist(2026, 3, 14, 18, 0) }),
  //  8  4 stars, HAS a reply but NO reply timestamp — answered, not timeable
  v4({ id: 'H08', author: 'Priya', rating: 4, text: 'Good biryani',
       createTime: ist(2026, 3, 18, 20, 0), reply: 'Thanks Priya!' }),
  //  9  1 star, replied 72h later
  v4({ id: 'H09', author: 'Suresh', rating: 1, text: 'Very disappointed',
       createTime: ist(2026, 3, 22, 11, 0), reply: 'We are sorry.', replyAt: ist(2026, 3, 25, 11, 0) }),
  // 10  5 stars late at night, still the same IST day
  v4({ id: 'H10', author: 'Anita', rating: 5, text: 'Lovely ambience', createTime: ist(2026, 3, 25, 23, 30) }),
  // 11  2 stars at 02:00 IST = 20:30 UTC the PREVIOUS day. If bucketing is done
  //     on the stored UTC string this lands on the 27th and the daily count is wrong.
  v4({ id: 'H11', author: 'Mohan', rating: 2, text: 'Too loud', createTime: ist(2026, 3, 28, 2, 0) }),
  // 12  4 stars, replied 6h later — the fastest reply in the set
  v4({ id: 'H12', author: 'Lakshmi', rating: 4, text: 'Good evening out',
       createTime: ist(2026, 3, 31, 15, 0), reply: 'Thank you!', replyAt: ist(2026, 3, 31, 21, 0) }),
  // 13  01:30 IST on 1 April = 20:00 UTC on 31 March. Belongs to APRIL.
  //     Rating-only: no text at all, which is extremely common and must not be
  //     counted as a review that "mentioned" any theme.
  v4({ id: 'H13', author: 'Jaya', rating: 5, createTime: ist(2026, 4, 1, 1, 30) }),
];

/** The clock the hand figures assume. Fixed so "is it past the 48h grace" and
 *  "how old is the oldest unanswered" are not a function of when the suite runs. */
const HAND_NOW = Date.parse('2026-05-01T00:00:00Z');

/* ══════════════════════════════════════════════════════════════════════════
 * 2. BULK — about 400 reviews across 14 months, deterministic.
 * ══════════════════════════════════════════════════════════════════════════ */

const GOOD_TEXTS = [
  'Excellent food and very good service. Highly recommend the kebabs.',
  'Great ambience, the live band was brilliant on Saturday night.',
  'Biryani was superb, staff were friendly and attentive throughout.',
  'Perfect place for a family dinner. Portions are generous.',
  'చాలా బాగుంది, ఆహారం రుచికరంగా ఉంది', // Telugu: very good, the food was tasty
  'Khana bahut accha tha, service bhi fast thi',
  'Loved it 😍 the cocktails are worth the price',
  'Been coming here for years. Never disappoints.',
  'Good value for money and the parking was easy on a weekday.',
  '',   // rating-only: no text
  '',
];

const BAD_TEXTS = [
  'Waited over an hour for the main course. Nobody apologised.',
  'Food was cold and the staff were rude when we mentioned it.',
  'Very overpriced for what you get. Portions have shrunk.',
  'The washroom was dirty and there was a smell near the seating.',
  'Music far too loud, could not hear anyone at the table.',
  'Booking was not honoured, we waited 40 minutes for a reserved table.',
  'Bill had an extra charge nobody could explain.',
];

const MID_TEXTS = [
  'Food was fine, service could be quicker.',
  'Average. Nothing wrong but nothing special either.',
  'Good food, slow service. Mixed evening.',
];

const NAMES = [
  'Ravi Teja', 'Sowmya K', 'Imran Ali', 'Nikhil Reddy', 'Pooja Sharma', 'Harsha V',
  'Divya M', 'Sandeep', 'Meera Rao', 'Ajay Kumar', 'Kavya S', 'Rahul N', 'Zara Khan',
  'Bhavana', 'Girish P', 'Naveen', 'Swathi', 'Tarun', 'Ishita', 'Manoj Babu',
];

const REPLIES = [
  'Thank you for the kind words, we look forward to hosting you again.',
  'We are sorry this was your experience. Please write to us so we can make it right.',
  'Thanks for the feedback, we have shared this with the team.',
];

/**
 * Fourteen months, March 2025 to April 2026, ~28 reviews a month, with a
 * deliberate collapse in November 2025 (a kitchen change) so trend, period
 * alerts and the below-norm rule all have something real to find. Everything is
 * driven by the seeded PRNG: same seed, same 400 reviews, every run.
 */
function buildBulk(seed = 20260909) {
  const rand = rng(seed);
  const out = [];
  let n = 0;

  const months = [];
  for (let i = 0; i < 14; i++) {
    const m = 3 + i;                     // March 2025 onward
    months.push({ y: 2025 + Math.floor((m - 1) / 12), m: ((m - 1) % 12) + 1 });
  }

  for (const { y, m } of months) {
    const badMonth = (y === 2025 && m === 11);
    const perMonth = badMonth ? 34 : 26 + Math.floor(rand() * 6);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

    for (let i = 0; i < perMonth; i++) {
      n++;
      const day = 1 + Math.floor(rand() * daysInMonth);
      // Restaurant reviews cluster in the evening; a couple land after midnight,
      // which is what makes IST bucketing matter.
      const hour = rand() < 0.08 ? Math.floor(rand() * 3) : 12 + Math.floor(rand() * 12);
      const minute = Math.floor(rand() * 60);
      const createTime = ist(y, m, day, hour, minute);

      const roll = rand();
      let rating;
      if (badMonth) rating = roll < 0.40 ? 1 : roll < 0.62 ? 2 : roll < 0.78 ? 3 : roll < 0.92 ? 4 : 5;
      else rating = roll < 0.55 ? 5 : roll < 0.80 ? 4 : roll < 0.90 ? 3 : roll < 0.96 ? 2 : 1;

      const pool = rating >= 4 ? GOOD_TEXTS : rating === 3 ? MID_TEXTS : BAD_TEXTS;
      const text = pool[Math.floor(rand() * pool.length)];

      // 1 in 8 reviewers is anonymous — Google shows them as "A Google user",
      // which is the case that forces the composite_anon identity basis.
      const anonymous = rand() < 0.125;
      const author = anonymous ? null : NAMES[Math.floor(rand() * NAMES.length)];

      // Replies: much more likely on bad reviews (which is what a venue that is
      // paying attention actually does), and 1 in 5 replies has no timestamp.
      const replyChance = rating <= 2 ? 0.7 : 0.3;
      const replied = rand() < replyChance;
      const reply = replied ? REPLIES[rating <= 2 ? 1 : Math.floor(rand() * REPLIES.length)] : null;
      const replyAt = replied && rand() > 0.2 ? addHours(createTime, 2 + Math.floor(rand() * 200)) : null;

      out.push(v4({
        id: `B${String(n).padStart(4, '0')}`,
        author,
        rating,
        text,
        createTime,
        reply,
        replyAt,
        language: rand() < 0.1 ? 'te' : 'en',
      }));
    }
  }

  // A burst weekend: 11 reviews on one Saturday, which is what a volume_spike
  // alert is supposed to notice.
  for (let i = 0; i < 11; i++) {
    n++;
    out.push(v4({
      id: `B${String(n).padStart(4, '0')}`,
      author: NAMES[i % NAMES.length],
      rating: i < 7 ? 5 : 4,
      text: GOOD_TEXTS[i % GOOD_TEXTS.length],
      createTime: ist(2026, 2, 14, 19, i * 4),
    }));
  }

  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. EDGE CASES
 * ══════════════════════════════════════════════════════════════════════════ */

/** A CSV in the shape a manager's spreadsheet actually arrives in: different
 *  column names, quoted commas, an embedded newline inside a review, a doubled
 *  quote, DD/MM dates, and one blank line. */
const EDGE_CSV = [
  'Review ID,Reviewer Name,Rating,Comment,Date,Owner Reply,Reply Date',
  'C01,Anil,5,"Great food, great service",02/03/2026,,',
  'C02,Bina,4,"Line one\nLine two about the ""kebabs""",05/03/2026,"Thanks Bina",06/03/2026',
  '',
  'C03,A Google user,3,Just okay,13/04/2026,,',
  'C04,Chetan,2,"Slow, and the bill was wrong",28/02/2026,,',
].join('\n');

/** Rows the parser must REFUSE, each with the reason it exists. */
const EDGE_BAD = [
  { why: 'STAR_RATING_UNSPECIFIED means Google does not know — inventing a 3 would be worse than an error row',
    row: { reviewId: 'X01', starRating: 'STAR_RATING_UNSPECIFIED', createTime: ist(2026, 3, 1, 12, 0), comment: 'hmm' } },
  { why: 'a fractional rating is an AVERAGE that leaked into a per-review column',
    row: { reviewId: 'X02', starRating: 4.3, createTime: ist(2026, 3, 1, 12, 0), comment: 'ok' } },
  { why: 'a relative date cannot produce a daily count — this is what scraped exports return',
    row: { reviewId: 'X03', starRating: 'FIVE', createTime: '2 months ago', comment: 'great' } },
  { why: 'a rating of 7 on a 5-star scale is corrupt data, not a very happy guest',
    row: { reviewId: 'X04', starRating: 7, createTime: ist(2026, 3, 1, 12, 0), comment: 'wow' } },
  { why: 'a date before Google reviews existed is a parse failure wearing a valid-looking string',
    row: { reviewId: 'X05', starRating: 'FIVE', createTime: '1899-01-01T00:00:00Z', comment: 'ancient' } },
];

/** Rows the parser must ACCEPT while doing something specific with them. */
const EDGE_GOOD = [
  // 'FIVE' as a word, no id at all -> composite identity on author+time
  { reviewId: '', reviewer: { displayName: 'Naya Singh' }, starRating: 'FIVE',
    createTime: ist(2026, 3, 3, 19, 0), comment: 'Wonderful' },
  // anonymous, no id, no text: nothing but the rating and the instant
  { reviewer: { displayName: 'A Google user', isAnonymous: true }, starRating: 'FOUR',
    createTime: ist(2026, 3, 3, 19, 0) },
  // an EXACT duplicate of the row above: two different anonymous people can
  // leave the same rating in the same second. Must stay TWO reviews.
  { reviewer: { displayName: 'A Google user', isAnonymous: true }, starRating: 'FOUR',
    createTime: ist(2026, 3, 3, 19, 0) },
  // a reply stamped BEFORE the review: keep the reply, drop the impossible time
  { reviewId: 'E04', reviewer: { displayName: 'Gopal' }, starRating: 'THREE',
    createTime: ist(2026, 3, 4, 20, 0), comment: 'Mixed',
    reviewReply: { comment: 'Thanks', updateTime: ist(2026, 3, 1, 10, 0) } },
];

/* ── Assembly ─────────────────────────────────────────────────────────────── */

function takeoutJson(reviews) {
  // The shape a v4 list response has, which is also what a Takeout reviews.json
  // looks like. averageRating/totalReviewCount are the reconciliation figures.
  const sum = reviews.reduce((a, r) => a + ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[r.starRating] || 0), 0);
  return JSON.stringify({
    reviews,
    averageRating: Math.round((sum / reviews.length) * 10) / 10,
    totalReviewCount: reviews.length,
  }, null, 2);
}

function buildFixture(seed) {
  const bulk = buildBulk(seed);
  return {
    HAND_NOW,
    handMonth: HAND_MONTH,
    handMonthJson: takeoutJson(HAND_MONTH),
    bulk,
    bulkJson: takeoutJson(bulk),
    edgeCsv: EDGE_CSV,
    edgeBad: EDGE_BAD,
    edgeGood: EDGE_GOOD,
    edgeGoodJson: JSON.stringify({ reviews: EDGE_GOOD }),
    edgeBadJson: JSON.stringify({ reviews: EDGE_BAD.map(e => e.row) }),
    ist,
    addHours,
    v4,
  };
}

module.exports = { buildFixture, ist, addHours, v4, HAND_NOW };

/* ── CLI ──────────────────────────────────────────────────────────────────── */

if (require.main === module) {
  const f = buildFixture();
  const writeIdx = process.argv.indexOf('--write');
  if (writeIdx !== -1 && process.argv[writeIdx + 1]) {
    const dir = path.resolve(process.argv[writeIdx + 1]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviews-hand-month.json'), f.handMonthJson);
    fs.writeFileSync(path.join(dir, 'reviews-bulk.json'), f.bulkJson);
    fs.writeFileSync(path.join(dir, 'reviews-edge.csv'), f.edgeCsv);
    console.log(`wrote 3 fixture files into ${dir}`);
  }
  console.log(`hand month : ${f.handMonth.length} reviews (March-April 2026)`);
  console.log(`bulk       : ${f.bulk.length} reviews across 14 months`);
  console.log(`edge CSV   : ${f.edgeCsv.split('\n').length} lines`);
  console.log(`edge good  : ${f.edgeGood.length} rows that must parse`);
  console.log(`edge bad   : ${f.edgeBad.length} rows that must be refused`);
}
