/**
 * Single source of truth for phone numbers and links.
 * No number and no URL belongs in any other file.
 */

export const WHATSAPP = '972523983394';

export const waLink = (text) =>
  `https://wa.me/${WHATSAPP}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

export const LINKS = {
  home: '/index.html',
  freeGuide: '/free-guide.html',
  games: '/games.html',
  thankYou: '/thank-you.html',
  form: 'https://bucolic-lollipop-f39cc5.netlify.app/',

  // TODO(kfir): the GROW payment page for the ₪99 operational guide.
  // Until this is set, buyGuide() sends people to WhatsApp instead of a dead
  // link — a customer who wants to pay always reaches a human.
  buyGuide: '',
};

export const MESSAGES = {
  buyGuide: 'היי, אשמח לרכוש את המדריך התפעולי לשבת חתן',
  help: 'היי ערדית, אשמח לעזרה במציאת מתחם לשבת חתן',
  guideQuestion: 'היי, יש לי שאלה על המדריך',
};

/** Where the "buy the guide" button should go right now. */
export const buyGuideHref = () => LINKS.buyGuide || waLink(MESSAGES.buyGuide);
