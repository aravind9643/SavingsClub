/**
 * Font Awesome icons, wrapped so the rest of the app keeps using plain
 * `<IconX width={18} height={18} />` and never imports FA directly.
 *
 * Tree-shaken: each glyph is imported individually from free-solid-svg-icons,
 * so only the ones listed here ship. `autoAddCss = false` stops FA injecting
 * its own <style> at runtime — the sizing below is ours.
 */
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { config, type IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faHouse, faCalendarCheck, faIndianRupeeSign, faReceipt, faWallet,
  faBuildingColumns, faUserGroup, faGear, faClipboardList, faSun, faMoon,
  faRightFromBracket, faChevronRight, faXmark, faPlus, faEllipsis, faCheck,
  faArrowUp, faArrowDown, faInbox, faTableColumns, faHandHoldingDollar,
} from '@fortawesome/free-solid-svg-icons';

config.autoAddCss = false;

interface P {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

/** One wrapper so every icon sizes and colours identically. */
function make(icon: IconDefinition) {
  return function Icon({ width = 20, height, className, style }: P) {
    const size = height ?? width;
    return (
      <FontAwesomeIcon
        icon={icon}
        className={className}
        style={{ width: size, height: size, ...style }}
      />
    );
  };
}

/* navigation */
export const IconHome = make(faHouse);
export const IconDashboard = make(faTableColumns);
export const IconContributions = make(faCalendarCheck);
export const IconLoans = make(faIndianRupeeSign);
export const IconExpenses = make(faReceipt);
export const IconCash = make(faWallet);
export const IconWallet = make(faWallet);
export const IconBank = make(faBuildingColumns);
export const IconMembers = make(faUserGroup);
export const IconSettings = make(faGear);
export const IconAudit = make(faClipboardList);
export const IconMore = make(faEllipsis);

/* actions and states */
export const IconSun = make(faSun);
export const IconMoon = make(faMoon);
export const IconLogout = make(faRightFromBracket);
export const IconChevron = make(faChevronRight);
export const IconClose = make(faXmark);
export const IconPlus = make(faPlus);
export const IconCheck = make(faCheck);
export const IconArrowUp = make(faArrowUp);
export const IconArrowDown = make(faArrowDown);
export const IconInbox = make(faInbox);
export const IconLoan = make(faHandHoldingDollar);
