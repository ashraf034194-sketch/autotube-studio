// ─── HYBRID IMAGE ENGINE — Content-type detection + query building ────────
//
// The hybrid engine routes each image-slot to either:
//   • STOCK PHOTO route (Pexels → Unsplash → Z.ai fallback) — for concrete,
//     generic, photographable subjects ("person reading a book", "city skyline",
//     "cup of coffee", "mountain landscape", "person exercising")
//   • AI-GENERATION route (Z.ai only) — for unique, specific, abstract, or
//     branded content ("visual metaphor for growth", "specific branded scene",
//     "highly specific narrative moment")
//
// LOAD DISTRIBUTION TARGET (75/25):
//   • ~75% of images should come from Pexels + Unsplash (stock photos —
//     fast, free, commercial-use-licensed, ~0.3s per image)
//   • ~25% from Z.ai (AI-generation — for abstract / metaphorical content
//     that has no literal stock photo match)
//
// To achieve this NATURAL TENDENCY (not a hard rule), the detector is tuned
// to BIAS TOWARD CONCRETE for borderline cases. Generic, everyday prompts
// like "person walking", "coffee cup", "city street", "person exercising"
// route to stock even when mildly abstract words appear alongside them.
// Only genuinely abstract / metaphorical prompts (3+ abstract signals with
// no concrete override, OR explicit "visual metaphor for X" phrasing) route
// to AI-generation.
//
// The detection is a cheap keyword-heuristic (no LLM call needed — fast).
// The query-builder strips the Style DNA wrapping from the prompt and
// extracts a 2-4 keyword phrase that's search-friendly for Pexels/Unsplash.

// ─── Content-type keywords ─────────────────────────────────────────────────

/**
 * Concrete, photographable subjects. If the prompt mentions these (or their
 * synonyms), it routes to STOCK PHOTOS.
 *
 * Organized by category for clarity. The detector scans the prompt for any
 * word in this set (case-insensitive, word-boundary matching).
 *
 * EXPANDED 2025-09 to cover more everyday / generic prompts — added common
 * materials, architectural elements, household items, fabrics, common verbs,
 * and contextual nouns that bias toward "concrete" routing (the 75/25 target).
 */
const CONCRETE_KEYWORDS = new Set<string>([
  // ── People / body parts ──
  'person', 'people', 'man', 'woman', 'boy', 'girl', 'child', 'children', 'kid',
  'baby', 'family', 'couple', 'friend', 'friends', 'crowd', 'audience', 'hand',
  'hands', 'face', 'eye', 'eyes', 'foot', 'feet', 'head', 'shoulder', 'arm',
  'leg', 'finger', 'hair', 'skin', 'smile', 'worker', 'employee', 'student',
  'teacher', 'doctor', 'nurse', 'chef', 'athlete', 'runner', 'cyclist', 'man',
  'guy', 'lady', 'mom', 'mother', 'dad', 'father', 'parent', 'grandmother',
  'grandfather', 'senior', 'elderly', 'toddler', 'infant', 'teen', 'teenager',
  'adult', 'professional', 'expert', 'specialist', 'artist', 'musician',
  'painter', 'photographer', 'engineer', 'architect', 'scientist', 'farmer',
  'fisherman', 'baker', 'barista', 'waiter', 'waitress', 'driver', 'pilot',
  'soldier', 'police', 'officer', 'firefighter', 'volunteer',
  // ── Actions (concrete verbs + nouns) ──
  'reading', 'book', 'writing', 'walking', 'running', 'jogging', 'cycling',
  'swimming', 'cooking', 'eating', 'drinking', 'sleeping', 'waking', 'sitting',
  'standing', 'lifting', 'pushing', 'pulling', 'opening', 'closing', 'driving',
  'flying', 'climbing', 'hiking', 'dancing', 'singing', 'playing', 'working',
  'studying', 'learning', 'typing', 'talking', 'phone', 'call', 'meeting',
  'presentation', 'exercise', 'exercising', 'workout', 'gym', 'pushup',
  'pushups', 'pushup', 'plank', 'yoga', 'stretch', 'stretching', 'meditation',
  'meditating', 'praying', 'kneeling', 'bowing', 'greeting', 'hugging',
  'kissing', 'shaking', 'handshake', 'high-five', 'smiling', 'laughing',
  'crying', 'weeping', 'waving', 'pointing', 'looking', 'watching', 'listening',
  'holding', 'carrying', 'lifting', 'throwing', 'catching', 'kicking',
  'punching', 'jumping', 'leaping', 'landing', 'falling', 'diving', 'rowing',
  'paddling', 'surfing', 'skiing', 'snowboarding', 'skating', 'skateboard',
  'riding', 'biking', 'strolling', 'wandering', 'exploring', 'traveling',
  'packing', 'unpacking', 'shopping', 'buying', 'selling', 'paying',
  'counting', 'calculating', 'measuring', 'weighing', 'testing', 'fixing',
  'repairing', 'building', 'constructing', 'demolishing', 'painting',
  'drawing', 'sketching', 'sculpting', 'carving', 'sewing', 'knitting',
  'ironing', 'washing', 'cleaning', 'scrubbing', 'sweeping', 'mopping',
  'gardening', 'planting', 'watering', 'harvesting', 'fishing', 'hunting',
  // ── Places / scenes ──
  'city', 'cities', 'skyline', 'street', 'road', 'highway', 'building', 'office',
  'room', 'kitchen', 'bedroom', 'living', 'bathroom', 'classroom', 'library',
  'cafe', 'coffee', 'restaurant', 'bar', 'shop', 'store', 'mall', 'park',
  'garden', 'yard', 'balcony', 'patio', 'rooftop', 'beach', 'ocean', 'sea',
  'lake', 'river', 'stream', 'waterfall', 'mountain', 'mountains', 'hill',
  'valley', 'forest', 'woods', 'jungle', 'desert', 'canyon', 'cliff', 'cave',
  'island', 'bridge', 'tunnel', 'airport', 'station', 'port', 'harbor',
  'subway', 'train', 'bus', 'car', 'truck', 'motorcycle', 'bicycle', 'bike',
  'boat', 'ship', 'plane', 'airplane', 'helicopter', 'sidewalk', 'pavement',
  'asphalt', 'path', 'trail', 'track', 'field', 'meadow', 'prairie', 'plain',
  'plateau', 'ridge', 'peak', 'summit', 'glacier', 'iceberg', 'volcano',
  'geyser', 'cliff', 'dune', 'oasis', 'countryside', 'suburb', 'neighborhood',
  'downtown', 'village', 'town', 'metropolis', 'skyscraper', 'tower',
  'cottage', 'cabin', 'tent', 'cabin', 'barn', 'garage', 'basement', 'attic',
  'hallway', 'corridor', 'staircase', 'stairs', 'elevator', 'escalator',
  'lobby', 'entrance', 'exit', 'doorway', 'gateway', 'fence', 'wall',
  // ── Objects / items ──
  'table', 'desk', 'chair', 'sofa', 'couch', 'bed', 'lamp', 'window', 'door',
  'clock', 'watch', 'phone', 'smartphone', 'laptop', 'computer', 'monitor',
  'keyboard', 'mouse', 'headphones', 'speaker', 'camera', 'tv', 'television',
  'fridge', 'oven', 'stove', 'microwave', 'glass', 'cup', 'mug', 'bottle',
  'plate', 'bowl', 'spoon', 'fork', 'knife', 'pan', 'pot', 'food', 'meal',
  'fruit', 'vegetable', 'bread', 'sandwich', 'salad', 'coffee', 'tea', 'juice',
  'water', 'wine', 'beer', 'flower', 'flowers', 'tree', 'trees', 'plant',
  'leaf', 'grass', 'rock', 'stone', 'sand', 'snow', 'rain', 'cloud', 'clouds',
  'sky', 'sun', 'sunrise', 'sunset', 'moon', 'star', 'stars', 'fire', 'flame',
  'candle', 'book', 'books', 'newspaper', 'magazine', 'notebook', 'pen', 'pencil',
  'painting', 'art', 'sculpture', 'statue', 'fountain', 'clock-tower',
  'backpack', 'bag', 'purse', 'wallet', 'umbrella', 'glasses', 'sunglasses',
  'hat', 'cap', 'helmet', 'gloves', 'scarf', 'jacket', 'coat', 'shirt',
  'pants', 'jeans', 'dress', 'skirt', 'shoes', 'boots', 'sneakers',
  'bedsheet', 'blanket', 'pillow', 'towel', 'curtain', 'rug', 'carpet',
  'mirror', 'picture', 'frame', 'shelf', 'cabinet', 'drawer', 'counter',
  'sink', 'faucet', 'toilet', 'shower', 'bathtub', 'doorbell', 'lock',
  'key', 'keys', 'chain', 'rope', 'string', 'thread', 'fabric', 'cloth',
  'leather', 'wool', 'cotton', 'silk', 'denim', 'canvas', 'paper', 'cardboard',
  'plastic', 'metal', 'steel', 'iron', 'copper', 'gold', 'silver', 'wood',
  'wooden', 'bamboo', 'brick', 'concrete', 'cement', 'tile', 'marble',
  'floor', 'ceiling', 'wall', 'window-frame', 'door-frame',
  // ── Weather / time-of-day ──
  'morning', 'noon', 'afternoon', 'evening', 'night', 'midnight', 'dawn',
  'dusk', 'winter', 'spring', 'summer', 'autumn', 'fall', 'sunny', 'cloudy',
  'rainy', 'snowy', 'foggy', 'stormy', 'windy', 'calm', 'sunrise', 'sunset',
  'twilight', 'blue-hour', 'golden-hour', 'overcast', 'drizzle', 'downpour',
  'blizzard', 'heatwave', 'breeze', 'gust', 'hail', 'sleet', 'frost',
  // ── Animals / nature ──
  'dog', 'dogs', 'cat', 'cats', 'horse', 'cow', 'sheep', 'goat', 'pig',
  'chicken', 'duck', 'goose', 'bird', 'birds', 'fish', 'whale', 'dolphin',
  'shark', 'turtle', 'snake', 'lizard', 'frog', 'rabbit', 'squirrel', 'deer',
  'bear', 'lion', 'tiger', 'elephant', 'giraffe', 'zebra', 'monkey', 'gorilla',
  'puppy', 'kitten', 'cub', 'foal', 'lamb', 'calf', 'insect', 'bee', 'ant',
  'butterfly', 'spider', 'fly', 'mosquito', 'cricket', 'grasshopper',
  // ── Activities / sports ──
  'soccer', 'football', 'basketball', 'tennis', 'baseball', 'volleyball',
  'golf', 'surfing', 'skiing', 'snowboarding', 'skating', 'skateboard',
  'climbing', 'fishing', 'hunting', 'camping', 'picnic', 'barbecue', 'bbq',
  'game', 'games', 'match', 'tournament', 'practice', 'training', 'drill',
  // ── Food / drinks ──
  'breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'baking', 'roasting',
  'grilling', 'frying', 'boiling', 'pouring', 'serving', 'pizza', 'pasta',
  'rice', 'noodles', 'soup', 'stew', 'curry', 'burger', 'fries', 'steak',
  'chicken', 'fish', 'shrimp', 'egg', 'eggs', 'cheese', 'butter', 'milk',
  'cream', 'sugar', 'salt', 'pepper', 'spice', 'herb', 'sauce', 'honey',
  'chocolate', 'candy', 'cookie', 'cake', 'pie', 'donut', 'muffin',
  'smoothie', 'milkshake', 'cocktail', 'whiskey', 'vodka', 'rum', 'gin',
  // ── Business / tech ──
  'office', 'meeting', 'presentation', 'whiteboard', 'chart', 'graph',
  'computer', 'server', 'data', 'screen', 'interface', 'document', 'file',
  'folder', 'desk', 'cubicle', 'conference', 'handshake', 'business',
  'startup', 'company', 'team', 'project', 'deadline', 'report', 'plan',
  'strategy', 'launch', 'release', 'campaign', 'marketing', 'sales',
  'customer', 'client', 'partner', 'investor', 'founder', 'ceo', 'manager',
  'developer', 'designer', 'analyst', 'consultant', 'intern', 'receptionist',
  'security-guard', 'cashier', 'stocker', 'clerk', 'bartender', 'hostess'
])

/**
 * Abstract, conceptual, or metaphorical subjects. If the prompt mentions these,
 * it routes to AI-GENERATION (Z.ai) — stock photos won't have a literal match.
 *
 * Trigger words: metaphor, concept, abstract, idea, growth, success, etc.
 * Plus specific phrases that are unlikely to exist as stock photos.
 *
 * NOTE: As of the 2025-09 tuning, abstract routing requires 3+ abstract hits
 * with 0 concrete hits (OR explicit FORCE_AI_PHRASE). A single abstract word
 * like "transformation" alongside a concrete noun like "landscape" will NOT
 * trigger abstract routing — the prompt goes to stock (where Pexels likely
 * has a real landscape photo). This is the key change that achieves the 75/25
 * stock/AI split naturally.
 */
const ABSTRACT_KEYWORDS = new Set<string>([
  'metaphor', 'symbol', 'symbolism', 'abstract', 'concept', 'conceptual',
  'idea', 'ideas', 'thought', 'thoughts', 'feeling', 'feelings', 'emotion',
  'emotions', 'essence', 'spirit', 'soul', 'destiny', 'fate', 'karma',
  'dream', 'dreams', 'vision', 'visions', 'imagination', 'fantasy',
  'success', 'failure', 'hope', 'despair', 'love', 'hate', 'joy', 'sorrow',
  'growth', 'transformation', 'evolution', 'change', 'journey', 'path',
  'crossroads', 'milestone', 'beginning', 'ending', 'infinity', 'eternity',
  'silence', 'echo', 'memory', 'memories', 'nostalgia', 'regret',
  'motivation', 'inspiration', 'discipline', 'willpower', 'resilience',
  'courage', 'fear', 'anger', 'peace', 'war', 'freedom', 'captivity',
  'power', 'weakness', 'wealth', 'poverty', 'beauty', 'ugliness',
  'knowledge', 'wisdom', 'ignorance', 'truth', 'lie', 'honesty', 'deception',
  'time', 'past', 'future', 'present', 'history', 'prophecy', 'omen',
  'shadow', 'light', 'darkness', 'balance', 'harmony', 'chaos', 'order',
  'rebirth', 'renewal', 'awakening', 'enlightenment', 'nirvana',
  'spiritual', 'mystical', 'magical', 'supernatural', 'paranormal',
  'visualization', 'representation', 'depiction', 'illustration of',
  'allegory', 'parable', 'myth', 'legend', 'folklore',
  // ── Highly specific narrative moments (won't match stock) ──
  'specific', 'particular', 'exact', 'precise', 'branded', 'logo',
  'narrative', 'scene', 'moment', 'instance', 'episode', 'chapter',
  'story', 'tale', 'plot', 'character', 'protagonist', 'antagonist',
  'hero', 'villain', 'reunion', 'farewell', 'betrayal', 'redemption',
  'ritual', 'ceremony', 'sacrifice', 'oath', 'pledge', 'vow',
  // ── Surreal / impossible / artistic ──
  'surreal', 'impossible', 'floating', 'flying through', 'portal',
  'gateway', 'dimension', 'parallel', 'alternate', 'dreamscape',
  'psychedelic', 'kaleidoscope', 'fractal', 'cosmic', 'galactic',
  'celestial', 'astral', 'ethereal', 'otherworldly', 'alien', 'martian'
])

/**
 * Strong "force-AI" trigger phrases. If ANY of these appear in the prompt,
 * always route to AI-generation regardless of other keywords. These are the
 * user's explicitly abstract examples ("visual metaphor for growth", etc.).
 */
const FORCE_AI_PHRASES = [
  'visual metaphor',
  'metaphor for',
  'symbolic representation',
  'abstract concept of',
  'conceptual illustration of',
  'allegory of',
  'visualization of the idea',
  'depicting the concept',
  'representing the journey',
  'highly specific',
  'specific branded',
  'narrative moment'
]

// ─── Public API: content-type detection ────────────────────────────────────

export type ContentType = 'concrete' | 'abstract'

export interface DetectionResult {
  type: ContentType
  /** Score in [-10, +10]. Positive = concrete, negative = abstract. */
  score: number
  /** Number of concrete keywords matched. */
  concreteHits: number
  /** Number of abstract keywords matched. */
  abstractHits: number
  /** True if a force-AI phrase matched (always routes to AI). */
  forcedAi: boolean
  /** The matching keywords (for debugging / UI display). */
  matchedConcrete: string[]
  matchedAbstract: string[]
}

/**
 * Classify a prompt as concrete (photographable subject) or abstract
 * (metaphorical / conceptual / specific narrative). Uses keyword heuristics —
 * no LLM call needed (fast: ~1ms per prompt).
 *
 * ROUTING LOGIC (tuned 2025-09 for ~75/25 stock/AI split):
 *   1. If a FORCE_AI_PHRASE matches → abstract (regardless of other signals).
 *      These are explicit "visual metaphor for X" / "highly specific Y"
 *      phrasings that the user clearly wants AI-generated.
 *   2. Otherwise count concrete + abstract keyword hits.
 *   3. Route to ABSTRACT only if ALL of these are true:
 *      (a) No concrete keywords matched (concreteHits === 0), AND
 *      (b) At least MIN_ABSTRACT_HITS_FOR_ABSTRACT (3) abstract keywords matched.
 *          OR: abstractHits - concreteHits >= ABSTRACT_OVERRIDE_MARGIN (3)
 *              (i.e. abstract signals significantly outnumber concrete)
 *   4. Otherwise → concrete (default, stock photos probably have something
 *      for any common noun — this is the safer, cheaper bet and the natural
 *      bias that achieves the ~75% stock routing target).
 *
 * Examples (with the new tuned threshold):
 *   "person walking down a city street"
 *     → concrete: person, walking, city, street (4); abstract: 0 → CONCRETE ✓
 *   "coffee cup on a wooden table"
 *     → concrete: coffee, cup, wooden, table (4); abstract: 0 → CONCRETE ✓
 *   "the slow transformation of a landscape"
 *     → concrete: landscape (1); abstract: transformation (1)
 *     → abstractHits (1) - concreteHits (1) = 0 < ABSTRACT_OVERRIDE_MARGIN (3) → CONCRETE ✓
 *   "the journey of a thousand miles"
 *     → concrete: 0; abstract: journey (1) → 1 < MIN_ABSTRACT_HITS_FOR_ABSTRACT (3) → CONCRETE ✓
 *   "deeply emotional moment of sorrow and hope"
 *     → concrete: 0; abstract: moment, sorrow, hope (3) → 3 >= 3 → ABSTRACT ✓
 *   "growth, transformation, and rebirth"
 *     → concrete: 0; abstract: growth, transformation, rebirth (3) → 3 >= 3 → ABSTRACT ✓
 *   "visual metaphor for growth"
 *     → forcedAi=true → ABSTRACT ✓
 */
export function detectContentType(prompt: string): DetectionResult {
  const lower = prompt.toLowerCase()
  const tokens = lower.match(/\b[a-z][a-z-]+\b/g) ?? []

  const matchedConcrete: string[] = []
  const matchedAbstract: string[] = []

  for (const tok of tokens) {
    if (CONCRETE_KEYWORDS.has(tok)) matchedConcrete.push(tok)
    if (ABSTRACT_KEYWORDS.has(tok)) matchedAbstract.push(tok)
  }
  // De-dup (a token could only appear once but be safe).
  const concreteHits = new Set(matchedConcrete).size
  const abstractHits = new Set(matchedAbstract).size

  // Force-AI phrase check (substring match — these are multi-word).
  const forcedAi = FORCE_AI_PHRASES.some((p) => lower.includes(p))

  // Scoring: +1 per concrete hit, -2 per abstract hit (abstract is a stronger
  // signal because the prompt explicitly mentions an abstract concept).
  // The score is for telemetry / debugging — the actual routing uses the
  // stricter threshold-based logic below.
  const score = concreteHits - abstractHits * 2 - (forcedAi ? 10 : 0)

  // ── Tuned threshold for the 75/25 stock/AI split ──
  // Abstract routing requires SIGNIFICANT abstract signal — either many
  // abstract hits with no concrete, or abstract outnumbering concrete by 3+.
  const MIN_ABSTRACT_HITS_FOR_ABSTRACT = 3
  const ABSTRACT_OVERRIDE_MARGIN = 3 // abstractHits - concreteHits must be >= this

  let type: ContentType = 'concrete'
  if (forcedAi) {
    type = 'abstract'
  } else if (concreteHits === 0 && abstractHits >= MIN_ABSTRACT_HITS_FOR_ABSTRACT) {
    // Strong abstract signal with no concrete override → abstract.
    type = 'abstract'
  } else if (abstractHits - concreteHits >= ABSTRACT_OVERRIDE_MARGIN) {
    // Abstract significantly outnumbers concrete → abstract.
    // (Rare in practice — most prompts have lots of concrete nouns.)
    type = 'abstract'
  } else {
    // Default: concrete (stock photos probably have something — this is the
    // safer, cheaper bet that achieves the ~75% stock routing target).
    type = 'concrete'
  }

  return {
    type,
    score,
    concreteHits,
    abstractHits,
    forcedAi,
    matchedConcrete: Array.from(new Set(matchedConcrete)),
    matchedAbstract: Array.from(new Set(matchedAbstract))
  }
}

// ─── Public API: query-building ─────────────────────────────────────────────

/**
 * Common Style-DNA / cinematic-wrapping phrases that we want to STRIP from the
 * stock-search query. Pexels/Unsplash are keyword-search engines — adding
 * "cinematic photorealistic 16:9, warm golden-hour palette" to the query
 * actively HURTS the search (they'd return nothing).
 */
const STYLE_NOISE_PATTERNS = [
  /cinematic photorealistic[^,]*/gi,
  /photorealistic[^,]*/gi,
  /cinematic[^,]*/gi,
  /\b16:9\b[^,]*/gi,
  /warm golden-hour palette[^,]*/gi,
  /golden-hour palette[^,]*/gi,
  /golden hour[^,]*/gi,
  /soft directional lighting[^,]*/gi,
  /directional lighting[^,]*/gi,
  /eye-level medium shots[^,]*/gi,
  /low-angle hero shots[^,]*/gi,
  /intimate contemplative mood[^,]*/gi,
  /contemplative mood[^,]*/gi,
  /no text overlay[^,]*/gi,
  /no watermark[^,]*/gi,
  /backdrop[^,]*/gi,
  /bokeh[^,]*/gi,
  /depth of field[^,]*/gi,
  /sharp focus[^,]*/gi,
  /highly detailed[^,]*/gi,
  /intricate detail[^,]*/gi,
  /professional photography[^,]*/gi,
  /4k[^,]*/gi,
  /8k[^,]*/gi,
  /ultra[- ]?hd[^,]*/gi,
  /ultra realistic[^,]*/gi,
  /hyper realistic[^,]*/gi,
  /hyperrealistic[^,]*/gi,
  /natural lighting[^,]*/gi,
  /vintage filter[^,]*/gi,
  /film grain[^,]*/gi
]

/** Stopwords — removed from the extracted keyword phrase. */
const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'without', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these',
  'those', 'it', 'its', 'they', 'them', 'their', 'there', 'here', 'where',
  'when', 'why', 'how', 'what', 'who', 'whom', 'which', 'whose', 'while',
  'during', 'after', 'before', 'above', 'below', 'inside', 'outside',
  'into', 'onto', 'upon', 'over', 'under', 'between', 'among', 'through',
  'one', 'two', 'three', 'first', 'second', 'third', 'last', 'next',
  'some', 'any', 'all', 'both', 'each', 'every', 'few', 'many', 'much',
  'more', 'most', 'less', 'least', 'very', 'quite', 'rather', 'too',
  'just', 'only', 'even', 'still', 'also', 'too', 'than', 'then', 'now',
  'about', 'around', 'along', 'across', 'behind', 'beside', 'near',
  'against', 'toward', 'towards', 'until', 'since', 'because', 'although',
  'though', 'unless', 'whether', 'if', 'so', 'such',
  // Common filler verbs that don't add search value
  'doing', 'going', 'getting', 'having', 'making', 'taking', 'giving',
  'seeing', 'feeling', 'thinking', 'saying', 'coming', 'becoming'
])

/**
 * Build a 2-4 keyword search phrase from a full image-generation prompt.
 *
 * Strategy:
 *   1. Strip Style-DNA wrapping (palette, lighting, camera, "no text overlay",
 *      "no watermark", "16:9", "cinematic photorealistic", etc.).
 *   2. Take the leading clause of the prompt (everything before the first
 *      comma — the Style DNA wrapping is comma-separated and starts AFTER the
 *      concrete subject).
 *   3. Tokenize, drop stopwords, drop punctuation.
 *   4. Keep up to 4 of the remaining "important" words (nouns, adjectives,
 *      verbs). Prefer earlier words (the subject is at the START of the
 *      prompt — see the BATCH_PROMPT_SYSTEM rule #2 "SUBJECT FIRST").
 *
 * Examples:
 *   "a person doing pushups on wooden floor, cinematic photorealistic 16:9, warm golden-hour palette, soft directional lighting, no text overlay, no watermark"
 *     → "person doing pushups wooden floor"  (5 keywords — keep 4: "person pushups wooden floor")
 *   "a hand pouring water into a clear glass on a wooden nightstand, cinematic 16:9, golden-hour, ..."
 *     → "hand pouring water clear glass"  (4 keywords)
 */
export function buildStockQuery(prompt: string): string {
  let stripped = prompt
  for (const pat of STYLE_NOISE_PATTERNS) {
    stripped = stripped.replace(pat, ' ')
  }

  // Take the first clause (before first comma) — that's where the literal
  // subject lives, per the BATCH_PROMPT_SYSTEM rule. If the result is too
  // short (style wrapping stripped everything), fall back to the whole stripped
  // prompt.
  const firstClause = stripped.split(',')[0]?.trim() || stripped.trim()

  // Tokenize: words only, lowercase.
  const tokens = (firstClause.toLowerCase().match(/\b[a-z][a-z-]+\b/g) ?? []).filter(
    (t) => !STOPWORDS.has(t) && t.length > 2
  )

  if (tokens.length === 0) {
    // Edge case: stripping killed everything. Fall back to the raw prompt's
    // first clause (un-stripped) so we at least search for SOMETHING.
    const rawFirst = prompt.split(',')[0]?.trim() || prompt
    const rawTokens = (rawFirst.toLowerCase().match(/\b[a-z][a-z-]+\b/g) ?? []).filter(
      (t) => !STOPWORDS.has(t) && t.length > 2
    )
    return diluteTypographyQuery(rawTokens.slice(0, 4).join(' '))
  }

  // Keep the first 4 tokens (subject-first ordering — see BATCH_PROMPT_SYSTEM).
  return diluteTypographyQuery(tokens.slice(0, 4).join(' '))
}

/**
 * "Buzzword" abstract nouns that Pexels/Unsplash commonly return typography
 * posters for. If the stock query consists of just 1-2 of these (no concrete
 * noun), we dilute with a concrete noun to push the search toward real photos.
 *
 * Built from observed stock-search behavior — these are the words where the
 * top result is a "wooden letters spelling X" poster rather than a photograph.
 */
const TYPOGRAPHY_BUZZWORDS = new Set<string>([
  'impact',
  'growth',
  'success',
  'failure',
  'transformation',
  'change',
  'journey',
  'progress',
  'achievement',
  'accomplishment',
  'gratitude',
  'motivation',
  'inspiration',
  'discipline',
  'consistency',
  'persistence',
  'resilience',
  'courage',
  'hope',
  'dream',
  'vision',
  'focus',
  'purpose',
  'passion',
  'excellence',
  'mastery',
  'wisdom',
  'knowledge',
  'power',
  'strength',
  'freedom',
  'balance',
  'harmony',
  'peace',
  'abundance',
  'wealth',
  'happiness',
  'joy',
  'love',
  'time',
  'life',
  'mind',
  'soul',
  'spirit',
  'future',
  'destiny'
])

/**
 * Concrete nouns that, when present in the query, mean we DON'T need to dilute
 * — the query already has a photographable subject.
 */
const CONCRETE_DILUTION_WORDS = new Set<string>([
  'person', 'people', 'man', 'woman', 'boy', 'girl', 'child', 'hand', 'hands',
  'face', 'eye', 'foot', 'head', 'worker', 'student', 'teacher', 'athlete',
  'runner', 'cyclist', 'office', 'room', 'kitchen', 'bedroom', 'library',
  'cafe', 'restaurant', 'park', 'garden', 'beach', 'ocean', 'sea', 'lake',
  'river', 'mountain', 'forest', 'city', 'street', 'road', 'building',
  'table', 'desk', 'chair', 'bed', 'window', 'door', 'clock', 'phone',
  'laptop', 'computer', 'camera', 'glass', 'cup', 'mug', 'bottle', 'plate',
  'food', 'fruit', 'bread', 'coffee', 'tea', 'flower', 'tree', 'plant',
  'sky', 'sun', 'moon', 'book', 'pen', 'scene', 'landscape', 'photograph'
])

/**
 * TYPOGRAPHY-DILUTION: if the stock query is short (1-2 tokens) AND any token
 * is a "buzzword" abstract noun that stock libraries return typography posters
 * for, AND no concrete noun is present, append a dilution noun ("scene") to
 * push the search toward real photographs.
 *
 * This is a DEFENSIVE measure — the typography-poster filter in
 * stock-photos.ts (looksLikeTypography) is the primary guard that skips bad
 * results after the search returns. This function tries to make the search
 * itself return better candidates in the first place.
 */
function diluteTypographyQuery(query: string): string {
  if (!query) return query
  const queryTokens = query.split(' ')
  const hasBuzzword = queryTokens.some((t) => TYPOGRAPHY_BUZZWORDS.has(t))
  const hasConcreteNoun = queryTokens.some((t) => CONCRETE_DILUTION_WORDS.has(t))
  if (hasBuzzword && !hasConcreteNoun && queryTokens.length <= 2) {
    return query + ' scene'
  }
  return query
}
