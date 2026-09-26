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
  faHouse, faPiggyBank, faHandHoldingDollar, faVault, faReceipt, faWallet,
  faBuildingColumns, faPeopleGroup, faGear, faClockRotateLeft, faSun, faMoon,
  faRightFromBracket, faChevronRight, faChevronDown, faXmark, faPlus, faEllipsis, faCheck,
  faArrowUp, faArrowDown, faArrowLeft, faInbox, faTableColumns, faShareNodes, faCalendarCheck,
  faUserPen, faLayerGroup, faEye, faEyeSlash, faEnvelope, faLock, faKey,
  faCircleQuestion, faBookOpen, faLightbulb,
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
export const IconDeposits = make(faPiggyBank);
export const IconContributions = IconDeposits;
export const IconLoans = make(faHandHoldingDollar);
export const IconLoan = IconLoans;
export const IconTreasury = make(faVault);
export const IconVault = IconTreasury;
export const IconExpenses = make(faReceipt);
export const IconCash = make(faWallet);
export const IconWallet = make(faWallet);
export const IconBank = make(faBuildingColumns);
export const IconMembers = make(faPeopleGroup);
export const IconCommunity = IconMembers;
export const IconSettings = make(faGear);
export const IconAudit = make(faClockRotateLeft);
export const IconHistory = IconAudit;
export const IconMeeting = make(faCalendarCheck);
export const IconMore = make(faEllipsis);

/* actions and states */
export const IconUserEdit = make(faUserPen);
export const IconSwitch = make(faLayerGroup);
export const IconSun = make(faSun);
export const IconMoon = make(faMoon);
export const IconLogout = make(faRightFromBracket);
export const IconChevron = make(faChevronRight);
export const IconChevronDown = make(faChevronDown);
export const IconClose = make(faXmark);
export const IconPlus = make(faPlus);
export const IconCheck = make(faCheck);
export const IconArrowUp = make(faArrowUp);
export const IconArrowDown = make(faArrowDown);
export const IconArrowLeft = make(faArrowLeft);
export const IconBack = IconArrowLeft;
export const IconInbox = make(faInbox);
export const IconShare = make(faShareNodes);
export const IconEye = make(faEye);
export const IconEyeSlash = make(faEyeSlash);
export const IconLock = make(faLock);
export const IconEmail = make(faEnvelope);
export const IconKey = make(faKey);
export const IconHelp = make(faCircleQuestion);
export const IconBook = make(faBookOpen);
export const IconLightbulb = make(faLightbulb);
