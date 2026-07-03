// Akan, Hyderabad — menu data
// veg: 'v' (veg), 'n' (non-veg), 'e' (egg)
// spice: 0-3 (none, mild, medium, hot)

const MENU = {
  food: {
    label: 'Food',
    sub: [
      {
        id: 'soups', name: 'Soups', blurb: 'Slow-simmered, served piping hot',
        items: [
          { id: 's1', name: 'Tomato Basil Shorba', desc: 'Heirloom tomatoes, garden basil, a swirl of cream', price: 220, veg: 'v', spice: 1, tags: [], taste: { sour: 2, sweet: 1, spicy: 1, tangy: 2 }, pairs: ['w2', 'mk1'], hue: 14 },
          { id: 's2', name: 'Chicken Manchow', desc: 'Indo-Chinese classic with crispy noodles on top', price: 260, veg: 'n', spice: 2, tags: ['popular'], taste: { sour: 1, sweet: 0, spicy: 3, tangy: 2 }, pairs: ['ct1', 'c3'], hue: 28 },
          { id: 's3', name: 'Burnt Garlic & Sweet Corn', desc: 'Velvety corn with fragrant burnt-garlic oil', price: 230, veg: 'v', spice: 0, tags: [], taste: { sour: 0, sweet: 2, spicy: 0, tangy: 0 }, pairs: ['c2', 'mk2'], hue: 48 },
          { id: 's4', name: 'Hot & Sour Veg', desc: 'Bamboo shoot, mushroom, water chestnut, fiery broth', price: 230, veg: 'v', spice: 2, tags: [], taste: { sour: 3, sweet: 0, spicy: 3, tangy: 2 }, pairs: ['c2', 'mk1', 'w1'], hue: 18 },
        ],
      },
      {
        id: 'salads', name: 'Salads', blurb: 'Crisp, fresh, hand-tossed to order',
        items: [
          { id: 'sa1', name: 'Charred Corn & Halloumi', desc: 'Bell pepper, lime-coriander dressing, toasted almond', price: 320, veg: 'v', spice: 1, tags: ['chef'], taste: { sour: 1, sweet: 2, spicy: 1, tangy: 2 }, pairs: ['w2', 'ct1', 'mk2'], hue: 70 },
          { id: 'sa2', name: 'Quinoa Bowl', desc: 'Pomegranate, cucumber, mint, lemon-olive vinaigrette', price: 290, veg: 'v', spice: 0, tags: [], taste: { sour: 2, sweet: 1, spicy: 0, tangy: 2 }, pairs: ['mk2', 'h3'], hue: 90 },
          { id: 'sa3', name: 'Smoked Chicken Caesar', desc: 'Romaine, parmesan crisp, anchovy-garlic dressing', price: 360, veg: 'n', spice: 0, tags: [], taste: { sour: 1, sweet: 0, spicy: 0, tangy: 1 }, pairs: ['w2', 'ct1'], hue: 50 },
        ],
      },
      {
        id: 'small', name: 'Small Plates', blurb: 'Made for sharing across the table',
        items: [
          { id: 'sp1', name: 'Paneer Tikka', desc: 'Hung-curd marinated, char-grilled, mint chutney', price: 340, veg: 'v', spice: 2, tags: ['popular'], taste: { sour: 1, sweet: 1, spicy: 2, tangy: 1 }, pairs: ['c2', 'w1', 'mk1'], hue: 22 },
          { id: 'sp2', name: 'Hyderabadi Mirchi Bajji', desc: 'Stuffed banana chilli, gram-flour fritter, tangy chaat', price: 240, veg: 'v', spice: 3, tags: ['chef'], taste: { sour: 2, sweet: 0, spicy: 4, tangy: 2 }, pairs: ['c2', 'mk1', 'h2'], hue: 35 },
          { id: 'sp3', name: 'Chicken 65', desc: 'House recipe — curry leaf, red chilli, yoghurt', price: 380, veg: 'n', spice: 3, tags: ['popular'], taste: { sour: 1, sweet: 0, spicy: 4, tangy: 1 }, pairs: ['c2', 'ct3', 'mk1'], hue: 12 },
          { id: 'sp4', name: 'Truffle Mushroom Toast', desc: 'Sourdough, exotic mushroom, truffle oil, gruyère', price: 360, veg: 'v', spice: 0, tags: ['chef'], taste: { sour: 0, sweet: 1, spicy: 0, tangy: 0 }, pairs: ['w2', 'h3', 'ct1'], hue: 42 },
          { id: 'sp5', name: 'Crispy Corn Pepper Salt', desc: 'Sweet corn, curry leaf, julienne pepper', price: 280, veg: 'v', spice: 1, tags: [], taste: { sour: 0, sweet: 2, spicy: 1, tangy: 0 }, pairs: ['mk2', 'c3', 'mk1'], hue: 56 },
        ],
      },
      {
        id: 'main', name: 'Main Course', blurb: 'The heart of the kitchen',
        items: [
          { id: 'm1', name: 'Hyderabadi Chicken Biryani', desc: 'Long-grain rice, dum-cooked, mirchi-ka-salan, raita', price: 480, veg: 'n', spice: 2, tags: ['popular', 'chef'], taste: { sour: 1, sweet: 0, spicy: 3, tangy: 2 }, pairs: ['c2', 'ct2', 'mk3'], hue: 28 },
          { id: 'm2', name: 'Paneer Butter Masala', desc: 'Tomato-cashew gravy, fenugreek, finished with cream', price: 380, veg: 'v', spice: 1, tags: ['popular'], taste: { sour: 1, sweet: 2, spicy: 1, tangy: 1 }, pairs: ['c2', 'w1', 'mk2'], hue: 16 },
          { id: 'm3', name: 'Dal Akan', desc: 'Black lentils, slow-cooked overnight, smoked butter', price: 340, veg: 'v', spice: 1, tags: ['chef'], taste: { sour: 0, sweet: 1, spicy: 1, tangy: 1 }, pairs: ['w1', 'c2', 'h2'], hue: 30 },
          { id: 'm4', name: 'Mutton Rogan Josh', desc: 'Kashmiri chillies, yoghurt, fennel, deep aromatic', price: 540, veg: 'n', spice: 2, tags: [], taste: { sour: 1, sweet: 0, spicy: 3, tangy: 1 }, pairs: ['w1', 'ct2', 'c2'], hue: 8 },
          { id: 'm5', name: 'Veg Pulao', desc: 'Basmati rice, garden vegetables, whole spices', price: 320, veg: 'v', spice: 1, tags: [], taste: { sour: 0, sweet: 1, spicy: 1, tangy: 1 }, pairs: ['c2', 'mk1', 'w2'], hue: 52 },
          { id: 'm6', name: 'Butter Garlic Naan', desc: 'Tandoor-baked, salted butter, garlic confit', price: 90, veg: 'v', spice: 0, tags: [], taste: { sour: 0, sweet: 0, spicy: 0, tangy: 0 }, hue: 50 },
        ],
      },
      {
        id: 'pasta', name: 'Pasta & Pizza', blurb: 'Wood-fired and hand-rolled',
        items: [
          { id: 'p1', name: 'Margherita di Bufala', desc: 'San Marzano, buffalo mozzarella, basil', price: 420, veg: 'v', spice: 0, tags: ['popular'], taste: { sour: 2, sweet: 1, spicy: 0, tangy: 2 }, pairs: ['w1', 'w3', 'mk2'], hue: 12 },
          { id: 'p2', name: 'Penne Arrabbiata', desc: 'Roast tomato, calabrian chilli, garlic, parsley', price: 360, veg: 'v', spice: 2, tags: [], taste: { sour: 2, sweet: 0, spicy: 3, tangy: 2 }, pairs: ['w1', 'c3', 'mk1'], hue: 14 },
          { id: 'p3', name: 'Smoked Chicken Alfredo', desc: 'Fettuccine, parmesan, cracked pepper', price: 440, veg: 'n', spice: 0, tags: [], taste: { sour: 0, sweet: 1, spicy: 0, tangy: 0 }, pairs: ['w2', 'w3', 'ct1'], hue: 50 },
        ],
      },
      {
        id: 'dessert', name: 'Desserts', blurb: 'A sweet finish',
        items: [
          { id: 'd1', name: 'Double Ka Meetha', desc: 'Hyderabadi bread pudding, saffron, slivered almond', price: 260, veg: 'e', spice: 0, tags: ['chef'], taste: { sour: 0, sweet: 4, spicy: 0, tangy: 0 }, pairs: ['h1', 'h2', 'ct2'], hue: 36 },
          { id: 'd2', name: 'Tiramisù', desc: 'Espresso-soaked savoiardi, mascarpone, cocoa', price: 290, veg: 'e', spice: 0, tags: ['popular'], taste: { sour: 1, sweet: 3, spicy: 0, tangy: 1 }, pairs: ['h3', 'ct2', 'h4'], hue: 26 },
          { id: 'd3', name: 'Gulab Jamun', desc: 'Khoya dumpling, cardamom syrup, vanilla bean ice', price: 220, veg: 'v', spice: 0, tags: [], taste: { sour: 0, sweet: 4, spicy: 0, tangy: 0 }, pairs: ['h1', 'h2', 'h3'], hue: 20 },
        ],
      },
    ],
  },
  bev: {
    label: 'Beverages',
    sub: [
      {
        id: 'hot', name: 'Hot', blurb: 'Pulled, brewed, simmered',
        items: [
          { id: 'h1', name: 'Filter Coffee', desc: 'South Indian decoction, frothed milk, brass tumbler', price: 140, veg: 'v', spice: 0, tags: ['popular'], taste: { sour: 0, sweet: 2, spicy: 0, tangy: 0 }, hue: 28 },
          { id: 'h2', name: 'Masala Chai', desc: 'Black tea, ginger, cardamom, clove', price: 120, veg: 'v', spice: 0, tags: [], taste: { sour: 0, sweet: 2, spicy: 1, tangy: 0 }, hue: 30 },
          { id: 'h3', name: 'Cappuccino', desc: 'Single origin Chikmagalur, double shot', price: 180, veg: 'v', spice: 0, tags: [], taste: { sour: 0, sweet: 1, spicy: 0, tangy: 0 }, hue: 32 },
          { id: 'h4', name: 'Hot Chocolate', desc: '70% dark, salted, marshmallow', price: 220, veg: 'v', spice: 0, tags: [], taste: { sour: 0, sweet: 3, spicy: 0, tangy: 0 }, hue: 22 },
        ],
      },
      {
        id: 'cold', name: 'Cold', blurb: 'Iced, shaken, churned',
        items: [
          { id: 'c1', name: 'Cold Brew', desc: '16-hour steep, served black or with milk', price: 220, veg: 'v', spice: 0, tags: ['chef'], taste: { sour: 1, sweet: 0, spicy: 0, tangy: 0 }, hue: 18 },
          { id: 'c2', name: 'Sweet Lassi', desc: 'Hung curd, cardamom, rose petals', price: 160, veg: 'v', spice: 0, tags: [], taste: { sour: 1, sweet: 3, spicy: 0, tangy: 1 }, hue: 50 },
          { id: 'c3', name: 'Fresh Lime Soda', desc: 'Salted, sweet or split — take your pick', price: 120, veg: 'v', spice: 0, tags: [], taste: { sour: 3, sweet: 1, spicy: 0, tangy: 3 }, hue: 80 },
          { id: 'c4', name: 'Iced Latte', desc: 'Double shot, ice, oat milk on request', price: 200, veg: 'v', spice: 0, tags: [], taste: { sour: 1, sweet: 1, spicy: 0, tangy: 0 }, hue: 36 },
        ],
      },
      {
        id: 'mock', name: 'Mocktails', blurb: 'No alcohol, all flavour',
        items: [
          { id: 'mk1', name: 'Virgin Mojito', desc: 'Mint, lime, sugar, sparkling water', price: 220, veg: 'v', spice: 0, tags: ['popular'], taste: { sour: 2, sweet: 2, spicy: 0, tangy: 3 }, hue: 100 },
          { id: 'mk2', name: 'Watermelon Cooler', desc: 'Crushed watermelon, basil, lime', price: 240, veg: 'v', spice: 0, tags: [], taste: { sour: 1, sweet: 3, spicy: 0, tangy: 2 }, hue: 4 },
          { id: 'mk3', name: 'Hyderabadi Paan Mocktail', desc: 'Betel leaf, fennel, gulkand, lime', price: 260, veg: 'v', spice: 0, tags: ['chef'], taste: { sour: 1, sweet: 2, spicy: 0, tangy: 3 }, hue: 110 },
        ],
      },
      {
        id: 'wine', name: 'Wine & Cocktails', blurb: 'Curated by the bar — by the glass',
        items: [
          { id: 'w1', name: 'House Red', desc: 'Sula Rasa Shiraz · soft tannins, dark cherry', price: 460, veg: 'v', spice: 0, tags: ['popular'], taste: { sour: 1, sweet: 1, spicy: 0, tangy: 1 }, hue: 0 },
          { id: 'w2', name: 'Chenin Blanc', desc: 'Crisp, citrus, mineral · serve chilled', price: 460, veg: 'v', spice: 0, tags: [], taste: { sour: 2, sweet: 1, spicy: 0, tangy: 2 }, hue: 80 },
          { id: 'w3', name: 'Sparkling Rosé', desc: 'Dry, strawberry, fine bubble', price: 520, veg: 'v', spice: 0, tags: ['chef'], taste: { sour: 2, sweet: 2, spicy: 0, tangy: 2 }, hue: 350 },
          { id: 'ct1', name: 'Hyderabad Highball', desc: 'Gin, cucumber, kaffir lime, tonic', price: 480, veg: 'v', spice: 0, tags: ['popular'], taste: { sour: 2, sweet: 0, spicy: 0, tangy: 3 }, hue: 100 },
          { id: 'ct2', name: 'Saffron Old Fashioned', desc: 'Bourbon, saffron, orange peel, bitters', price: 540, veg: 'v', spice: 0, tags: ['chef'], taste: { sour: 1, sweet: 2, spicy: 0, tangy: 1 }, hue: 25 },
          { id: 'ct3', name: 'Spiced Mint Julep', desc: 'Bourbon, mint, jaggery, crushed ice', price: 520, veg: 'v', spice: 1, tags: [], taste: { sour: 1, sweet: 2, spicy: 1, tangy: 2 }, hue: 110 },
        ],
      },
      {
        id: 'smooth', name: 'Smoothies', blurb: 'Thick, cold, blended',
        items: [
          { id: 'sm1', name: 'Alphonso Mango', desc: 'Seasonal alphonso, yoghurt, honey', price: 260, veg: 'v', spice: 0, tags: ['popular'], taste: { sour: 1, sweet: 4, spicy: 0, tangy: 1 }, hue: 38 },
          { id: 'sm2', name: 'Mixed Berry', desc: 'Strawberry, blueberry, banana', price: 280, veg: 'v', spice: 0, tags: [], taste: { sour: 2, sweet: 3, spicy: 0, tangy: 2 }, hue: 340 },
          { id: 'sm3', name: 'Banana Walnut', desc: 'Banana, walnut, dates, almond milk', price: 260, veg: 'v', spice: 0, tags: [], taste: { sour: 0, sweet: 3, spicy: 0, tangy: 0 }, hue: 42 },
        ],
      },
    ],
  },
};

window.MENU = MENU;
