import client from "../assets/icons/client.svg?raw";
import database from "../assets/icons/database.svg?raw";
import dice from "../assets/icons/dice.svg?raw";
import fitView from "../assets/icons/fit-view.svg?raw";
import info from "../assets/icons/info.svg?raw";
import lock from "../assets/icons/lock.svg?raw";
import pooler from "../assets/icons/pooler.svg?raw";
import router from "../assets/icons/router.svg?raw";
import service from "../assets/icons/service.svg?raw";
import settings from "../assets/icons/settings.svg?raw";
import viewSettings from "../assets/icons/view-settings.svg?raw";

const icons = { client, database, dice, "fit-view": fitView, info, lock, pooler, router, service, settings, "view-settings": viewSettings };
export type IconName = keyof typeof icons;

/** Only bundled icon assets enter the markup sink; callers supply a name, never SVG or a URL. */
export function Icon({ name, size, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return <span className={className === undefined ? "icon" : `icon ${className}`}
    style={size === undefined ? undefined : { width: size, height: size }}
    role={label === undefined ? undefined : "img"} aria-label={label} aria-hidden={label === undefined ? true : undefined}
    dangerouslySetInnerHTML={{ __html: icons[name] }} />;
}
