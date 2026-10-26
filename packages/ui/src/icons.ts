/**
 * The icon set, behind our own names.
 *
 * The app imports icons from `@crm/ui`, never from the vendor package, for the
 * same reason it imports `Button` from here: the day the set is swapped (or a
 * tenant wants their own), it is one file, not a grep across every screen.
 *
 * Only what is used is listed. Each export is tree-shaken individually, so this
 * file costs nothing for an icon nobody renders — and it is a short, reviewable
 * answer to "which pictures does this product use".
 *
 * Icons are decorative by default (lucide sets `aria-hidden`), which is right:
 * every icon in this product sits next to a text label or inside a button that
 * has its own accessible name. An icon that is the only thing in a control goes
 * through `IconButton`, which requires the label.
 */
export type { LucideProps as IconProps } from 'lucide-react';

export {
  ArrowDown as ArrowDownIcon,
  ArrowLeft as ArrowLeftIcon,
  ArrowRightLeft as MoveIcon,
  ArrowUp as ArrowUpIcon,
  Ban as BlockedIcon,
  Bell as BellIcon,
  Bookmark as ViewsIcon,
  Building as AccountsIcon,
  CalendarCheck2 as MyDayIcon,
  CalendarClock as DueIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  ChevronsUpDown as SortIcon,
  CircleAlert as AlertIcon,
  CircleCheck as SuccessIcon,
  CircleDollarSign as DealsIcon,
  CircleX as LostIcon,
  Columns3 as ColumnsIcon,
  Command as CommandIcon,
  Download as ExportIcon,
  Ellipsis as MoreIcon,
  FileSpreadsheet as FileIcon,
  GripVertical as GripIcon,
  Inbox as InboxIcon,
  Info as InfoIcon,
  Keyboard as KeyboardIcon,
  KeyRound as AccessIcon,
  LayoutList as ListViewIcon,
  ListFilter as FilterIcon,
  Lock as LockIcon,
  LogOut as SignOutIcon,
  Mail as MailIcon,
  Menu as MenuIcon,
  PanelLeftClose as PanelLeftCloseIcon,
  PanelLeftOpen as PanelLeftOpenIcon,
  Pencil as EditIcon,
  Phone as PhoneIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
  SearchX as NoResultsIcon,
  Settings as SettingsIcon,
  LayoutDashboard as DashboardIcon,
  ListChecks as SetupIcon,
  SlidersHorizontal as CustomizeIcon,
  ListTodo as TaskIcon,
  NotebookPen as NoteIcon,
  ScrollText as AuditLogIcon,
  ShieldCheck as SecurityIcon,
  Trash2 as RecycleBinIcon,
  UserCog as DataRightsIcon,
  SquareKanban as BoardViewIcon,
  Tag as TagIcon,
  Target as LeadsIcon,
  TriangleAlert as WarningIcon,
  Trophy as WonIcon,
  Upload as ImportIcon,
  UserPlus as InviteIcon,
  Video as MeetingIcon,
  Users as ContactsIcon,
  UsersRound as TeamIcon,
  X as CloseIcon,
} from 'lucide-react';
