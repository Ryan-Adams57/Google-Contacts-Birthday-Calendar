# Google Contacts Birthday Calendar

Never miss a birthday again! This tool automatically syncs birthdays from your **Google Contacts** into a dedicated **Google Calendar**, complete with yearly reminders, using Google Apps Script.

## Why you need this

Because of privacy regulations, birthdays you save in Google Contacts don't automatically appear in Google Calendar, even with birthday syncing turned on. That leaves you two bad options: manually create (and maintain) a recurring event for every contact, or risk forgetting the people who matter.

This script solves that for you. It reads the birthdays already stored in your contacts and creates a recurring calendar event for each one, automatically.

## What you get

- **Automatic reminders** for every contact's birthday, right in Google Calendar.
- **One source of truth**: keep birthdays in Google Contacts alongside the rest of your contact info.
- **Hands-off syncing**: runs once a day in the background.
- **Quiet by design**: you're only emailed when there's a problem, plus an occasional status update.

## Getting started

### Step 1 - Add the code

1. Go to [script.google.com](https://script.google.com).
2. Create a **New project** and name it `Birthday Calendar`.
3. Open `code.gs` from this repository, select everything, and copy it.
4. Back in the Apps Script editor, open `code.gs` (it may just contain an empty `myFunction()`), select all, and paste the copied code over it.
5. In the left panel, click the **+** next to **Services**, then add both **People API** and **Google Calendar API**.
6. Click **Save project to Drive**.

### Step 2 - Configure and authorize

1. Review the settings in the `CONFIGURATION` section of the code. Each `const` has a comment explaining what it does.
2. For your first run, set `const debug = true` so you can watch progress in the console.
3. Click **Run** and grant permissions when prompted. At "Authorization required", click **Review Permissions** and choose the Google account with your contacts and calendar. You'll see an "app not verified" warning, so click **Advanced**, then **Go to Birthday Calendar (unsafe)**.
4. Sign in again and approve the requested access: **Mail** (for sign-in and error notifications), **Contacts** (to read contacts and find birthdays), and **Calendar** (to create and update birthday events).
5. Google will email you a security alert about the new permissions. Confirm it was you.

### Step 3 - Put it on autopilot

1. Set `debug` back to `false`.
2. Open **Triggers** in the left panel and click **Add Trigger**.
3. Use these settings:

| Setting | Value |
| --- | --- |
| Function to run | `update_birthdays` |
| Deployment | `Head` |
| Event source | `Time-driven` |
| Type | `Day timer` |
| Time of day | `10pm to 11pm` |
| Failure notification | default |

4. Click **Save**. That's it, you're done!

## Good to know

- **6-minute limit:** Google caps each script run at 6 minutes. To stay safe, the script stops around 5m30s and picks up where it left off on the next run. You'll get an email if this happens.
- **Monthly check-in:** Once a month the script sends a short "still working" email so you know everything's running.

## Everyday use

Just keep using Google Contacts and Google Calendar like you always do. Add a birthday to a contact, and the reminder shows up in your calendar automatically. No extra steps.

## Contributing

Issues and pull requests are welcome. Feel free to open one on GitHub.

## License

Released under the **GNU General Public License v3.0**. You're free to use it in your own projects; a link back to this repository is appreciated.
