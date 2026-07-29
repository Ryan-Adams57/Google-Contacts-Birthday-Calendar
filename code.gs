/*
 * Birthday Calendar for Google Contacts and Calendar using Apps Script
 *
 * created 2026 by Ryan Adams
 * https://github.com/Ryan-Adams57/Google-Contacts-Birthday-Calendar
 *
 * Released under the GNU General Public License v3.0.
 *
 * v1.4.0 - changes over v1.3.3:
 *   - Legacy tag keys from earlier versions removed entirely. Any series still
 *     carrying an old key is NOT recognised by this version. Run
 *     migrate_legacy_tags.gs once, to completion, BEFORE deploying this file,
 *     or the next run creates a duplicate series for every contact.
 *   - GmailApp replaced with MailApp for notifications. MailApp needs only the
 *     script.send_mail scope instead of full mailbox access.
 *   - Ships with an explicit appsscript.json manifest pinning the V8 runtime,
 *     the advanced services, and a least-privilege scope list.
 *   - Added a mass-duplicate guard. If the calendar holds many series this
 *     version does not recognise AND the script is about to create many new
 *     ones, it aborts instead of duplicating the whole calendar. This is the
 *     safety net for deploying before the tag migration has finished.
 *   - Every getEventSeriesById() result is null-checked. The API returns null
 *     for an inaccessible series rather than throwing, so the old code raised a
 *     misleading TypeError instead of naming the real problem.
 *
 * v1.3.3 - fixes over v1.3.2:
 *   1) Calendar resolution moved out of global scope. In v1.3.2 the calendar was
 *      resolved at file-load time, so a bad cal_id produced "No owned calendar
 *      accessible" with no indication of whether it was unconfigured, misspelled,
 *      subscribed-not-owned, or the wrong Google account.
 *   2) cal_id is now validated and the error message states which of those it is.
 *   3) Feb 29 series creation no longer builds an invalid "YYYY-02-29" date in
 *      non-leap years (this threw an API error in v1.3.2).
 *   4) Duplicate-series deletion is guarded per event. In v1.3.2, two occurrence
 *      ids belonging to the same series caused the second delete to throw.
 *   5) Error/status mail uses getEffectiveUser(), which is populated under a
 *      time-driven trigger. getActiveUser() can return "" there, which made the
 *      error handler itself throw and swallow the real error.
 *   6) Per-run write cap so a first full sync cannot silently burn the daily
 *      Calendar write quota.
 *   7) verify_setup() and delete_birthdays_dry_run() added for pre-flight checks.
 *
 * Event tags are unchanged ("Ryan-Adams57_birthday", "Ryan-Adams57_birthday_feb29"),
 * so series already in the calendar are still recognised and will NOT be duplicated.
 *
 * No guarantee, no warranty, no liability, no support.
 */

// ============================================================================
// === CONFIGURATION ===
// ============================================================================

/**
 * Calendar ID of the Google Calendar that will hold your contacts' birthdays.
 * You must own this calendar. Subscribed and shared calendars will not work.
 *
 * 1) Google Calendar > Settings
 * 2) Add calendar > Create new calendar > Name it (e.g. "My Birthdays") > Create
 * 3) Settings for my calendars > pick that calendar > scroll to "Integrate calendar"
 * 4) Copy the "Calendar ID" here, e.g. "abc123...@group.calendar.google.com"
 *
 * Leaving the placeholder in place is the single most common cause of
 * "No owned calendar accessible".
 * @type {string}
 */
const cal_id = "bad9895782e47e2e481ce4628e766981c93bacd228364d837abf797d504dbe4c@group.calendar.google.com";

/**
 * Title for the birthday series. Must contain "%s", replaced by the contact's
 * display name. If a year of birth is known, the next occurrence gets the age
 * appended, e.g. "Mr X's birthday 🎁 (19)".
 * Note: changing this value retitles EVERY existing series on the next run, which
 * costs one Calendar write per contact. Leave it alone unless you want that.
 * @type {string}
 */
const birthday_title = "%s's birthday 🎁";

/**
 * Date format used for the event description, so you can see the date of birth.
 * Only added when the contact's birthday includes a year.
 * @type {string}
 */
const birthday_description_format = "* dd MMM yyyy";

/**
 * Ignore years of birth at or below this value. Some apps store a placeholder
 * year when no real year is known. Set to 0 to always use the year if present.
 * @type {number}
 */
const birthday_description_ignore_before = 1901;

/**
 * Show birthdays as "busy" or "available".
 * Only affects series added or changed after this setting changes. To apply it
 * retroactively, run delete_birthdays() and let the next sync re-add everything.
 * @type {string}
 */
const birthday_show_as = "busy";

/**
 * Popup reminder, in minutes before the event start. Google allows 5 to 40320
 * (4 weeks). Set to boolean false for no reminder.
 * Only affects series added or changed after this setting changes.
 * @type {number|boolean}
 */
const birthday_reminder_minutes = 15;

/**
 * Start hour (0-23) for a one-hour birthday event, so reminders can fire
 * mid-day. Set to boolean false for all-day events starting at midnight.
 * Only affects series added or changed after this setting changes.
 * @type {number|boolean}
 */
const birthday_start_time = false;

/**
 * Maximum number of NEW series this script will create in a single run.
 * Purpose: a first full sync of several hundred contacts issues roughly four
 * Calendar writes per contact (create, tag, transparency, reminder). Consumer
 * accounts allow roughly 500 to 1000 Calendar writes per day, and exhausting
 * that blocks all Calendar writes for about 24 hours. The cap spreads a large
 * first sync over several daily runs instead of hitting the wall mid-job.
 * Set to 0 for no cap.
 * @type {number}
 */
const max_new_series_per_run = 100;

/**
 * Mass-duplicate guard thresholds.
 *
 * Renaming the event tag key orphans every series already in the calendar: the
 * script stops recognising them and recreates all of them as duplicates on its
 * next run. That signature is "many unrecognised events present" AND "many new
 * series about to be created" at the same time. When both counts reach the
 * threshold below, the run aborts and tells you to finish the tag migration.
 *
 * A genuine first install trips nothing, because an empty calendar has no
 * unrecognised events. Set to 0 to disable the guard entirely.
 * @type {number}
 */
const duplicate_guard_threshold = 10;

/**
 * Debug mode logs progress to the console instead of emailing on error.
 * Set to false for unattended trigger runs.
 * @type {boolean}
 */
const debug = false;

// ============================================================================
// === STOP: Do NOT edit anything below this line ===
// ============================================================================

/** @type {string} */
const version = "1.4.0";

/** Tag keys written onto every series this script owns. Do not change these. */
const TAG_BIRTHDAY = "Ryan-Adams57_birthday";
const TAG_FEB29 = "Ryan-Adams57_birthday_feb29";

/** Placeholder shipped in the repo. Used only to give a precise error message. */
const CAL_ID_PLACEHOLDER = "...@group.calendar.google.com";

/**
 * Own execution ceiling in milliseconds. 330000 = 5.5 minutes, against Google's
 * hard 6-minute limit. On timeout the run stops and resumes on the next trigger.
 * @type {number}
 */
const exec_limit = 330000;

/** Short month names, log output only. @type {string[]} */
const month_short = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Resolved start hour, or false for an all-day event.
 * Explicit integer check. v1.3.2 relied on boolean false coercing to 0, which
 * happened to work but made 0 (midnight) and false indistinguishable in intent.
 * @type {number|boolean}
 */
const birthday_start_hour = (
  typeof birthday_start_time === "number" &&
  birthday_start_time % 1 === 0 &&
  birthday_start_time >= 0 &&
  birthday_start_time <= 23
) ? birthday_start_time : false;

// ----------------------------------------------------------------------------
// Service accessors. Deliberately lazy: anything that touches CalendarApp or
// People at file-load time throws outside every try/catch in the file, which is
// what made the v1.3.2 failure so opaque.
// ----------------------------------------------------------------------------

/**
 * Fetch an event series by id, or throw a message that names the real problem.
 * getEventSeriesById returns null for a series that does not exist or is not
 * accessible; it does not throw. Dereferencing that null produced a misleading
 * TypeError in earlier versions.
 *
 * Must be called on the Calendar object, not on CalendarApp: CalendarApp's own
 * getEventSeriesById only resolves series on the DEFAULT calendar, which is not
 * where the birthday series live.
 * @param {GoogleAppsScript.Calendar.Calendar} calendar
 * @param {string} series_id
 * @returns {GoogleAppsScript.Calendar.CalendarEventSeries}
 * @throws {Error} if the series cannot be resolved
 */
function require_series(calendar, series_id) {
  const series = calendar.getEventSeriesById(series_id);
  if (!series) {
    throw new Error("Event series " + series_id + " could not be resolved on calendar \"" +
                    calendar.getName() + "\" (deleted, or not accessible to this account)");
  }
  return series;
}

/**
 * Read the contact id tag from an event or series.
 * Single point of change if the tag key is ever renamed again. A rename requires
 * a migration pass over existing series first, or every contact is duplicated.
 * @param {GoogleAppsScript.Calendar.CalendarEvent|GoogleAppsScript.Calendar.CalendarEventSeries} event
 * @returns {string|undefined} People API resourceName, or undefined if untagged
 */
function get_people_tag(event) {
  return event.getTag(TAG_BIRTHDAY);
}

/**
 * Read the Feb 29 marker from an event or series.
 * @param {GoogleAppsScript.Calendar.CalendarEvent|GoogleAppsScript.Calendar.CalendarEventSeries} event
 * @returns {string|undefined}
 */
function get_feb29_tag(event) {
  return event.getTag(TAG_FEB29);
}

/**
 * Resolve the birthday calendar, or throw with a message that says why not.
 * @returns {GoogleAppsScript.Calendar.Calendar} the owned birthday calendar
 * @throws {Error} if cal_id is unset, malformed, not owned, or on the wrong account
 */
function get_birthday_calendar() {
  if (typeof cal_id !== "string" || cal_id.trim() === "") {
    throw new Error("cal_id is empty. Set it in the CONFIGURATION section.");
  }

  if (cal_id.trim() === CAL_ID_PLACEHOLDER) {
    throw new Error(
      "cal_id is still the placeholder from the repository (\"" + CAL_ID_PLACEHOLDER + "\"). " +
      "Replace it with your real Calendar ID: Google Calendar > Settings > " +
      "Settings for my calendars > your birthday calendar > Integrate calendar > Calendar ID."
    );
  }

  if (cal_id.indexOf("@") === -1) {
    throw new Error("cal_id does not look like a Calendar ID (no \"@\"): " + cal_id);
  }

  let calendar = null;
  try {
    calendar = CalendarApp.getOwnedCalendarById(cal_id);
  } catch (err) {
    // Malformed ids and revoked scopes surface here rather than returning null.
    throw new Error("Calendar lookup failed for \"" + cal_id + "\": " + err.message);
  }

  if (!calendar) {
    const account = get_user_email() || "(unknown account)";
    const owned = list_owned_calendars_safe();
    throw new Error(
      "No owned calendar found with id \"" + cal_id + "\" for account " + account + ". " +
      "Either the id is wrong, the calendar is subscribed/shared rather than owned by this " +
      "account, or the script was authorized under a different Google account. " +
      "Owned calendars visible to this authorization: " +
      (owned.length ? owned.join(" | ") : "NONE")
    );
  }

  return calendar;
}

/**
 * List owned calendars for diagnostics. Never throws.
 * @returns {string[]} "name <id>" strings
 */
function list_owned_calendars_safe() {
  try {
    return CalendarApp.getAllOwnedCalendars().map(function (cal) {
      return cal.getName() + " <" + cal.getId() + ">";
    });
  } catch (err) {
    return ["(could not enumerate calendars: " + err.message + ")"];
  }
}

/**
 * Email address of the identity this script runs as.
 * getEffectiveUser() is populated under a time-driven trigger; getActiveUser()
 * frequently is not, which is why v1.3.2's error mail could itself fail.
 * @returns {string} email address, or "" if unavailable
 */
function get_user_email() {
  try {
    const effective = Session.getEffectiveUser().getEmail();
    if (effective) { return effective; }
  } catch (err) { /* fall through */ }
  try {
    return Session.getActiveUser().getEmail() || "";
  } catch (err) {
    return "";
  }
}

/**
 * Send a notification mail. Never throws: a failure here must not mask the
 * original error that triggered it.
 * @param {string} subject
 * @param {string} body
 * @returns {boolean} true if the mail was handed to Gmail
 */
function notify(subject, body) {
  const recipient = get_user_email();
  if (!recipient) {
    console.error("Cannot send notification, no recipient address available. Body was:\n" + body);
    return false;
  }
  try {
    // MailApp, not GmailApp: MailApp needs only the script.send_mail scope,
    // whereas GmailApp requests full read/write access to the whole mailbox.
    MailApp.sendEmail(recipient, subject, body);
    return true;
  } catch (err) {
    console.error("Notification mail failed (" + err.message + "). Body was:\n" + body);
    return false;
  }
}

/**
 * Yearly recurrence rule.
 * @returns {GoogleAppsScript.Calendar.EventRecurrence}
 */
function get_yearly_recurrence() {
  return CalendarApp.newRecurrence().addYearlyRule();
}

/**
 * Transparency value matching the birthday_show_as setting.
 * @returns {GoogleAppsScript.Calendar.EventTransparency}
 */
function get_birthday_status() {
  return ("available" === birthday_show_as)
    ? CalendarApp.EventTransparency.TRANSPARENT
    : CalendarApp.EventTransparency.OPAQUE;
}

// ----------------------------------------------------------------------------
// Pre-flight check
// ----------------------------------------------------------------------------

/**
 * Abort a run that is about to duplicate the whole calendar.
 *
 * The failure being prevented: if the tag key changes, series already in the
 * calendar stop being recognised, every contact looks unsynced, and the script
 * recreates the lot. Roughly four Calendar writes per contact against a consumer
 * ceiling of about 500 to 1000 writes per day, so it half-finishes, blocks all
 * Calendar writes for about 24 hours, and leaves a partly duplicated calendar
 * with no way to tell which copy is authoritative.
 *
 * The signature is both conditions at once: many events present that this
 * version cannot identify, and many series about to be created. A real first
 * install has no unidentified events, so it passes.
 *
 * @param {number} unrecognised_count events in the window with no readable tag
 * @param {number} to_create_count contacts with no matching series
 * @throws {Error} if both counts reach duplicate_guard_threshold
 */
function assert_no_mass_duplication(unrecognised_count, to_create_count) {
  if (duplicate_guard_threshold <= 0) { return; }
  if (unrecognised_count < duplicate_guard_threshold) { return; }
  if (to_create_count < duplicate_guard_threshold) { return; }

  throw new Error(
    "ABORTED before creating anything. The calendar holds " + unrecognised_count +
    " event(s) this version cannot identify, and " + to_create_count +
    " contact(s) look unsynced. That is the signature of an unfinished tag " +
    "migration, and continuing would create a duplicate series for every " +
    "contact. Run migrate_legacy_tags() to completion first. If you are certain " +
    "this is wrong (for example the calendar genuinely contains unrelated " +
    "events), set duplicate_guard_threshold = 0 to override."
  );
}

/**
 * Run this manually before anything else. Confirms which account the script is
 * authorized as, what calendars that account owns, whether cal_id resolves, and
 * how many contacts carry a birthday. Read-only: creates and deletes nothing.
 */
function verify_setup() {
  console.log("Birthday Calendar v" + version + " setup check");
  console.log("Authorized account: " + (get_user_email() || "(unavailable)"));
  console.log("Owned calendars:");
  list_owned_calendars_safe().forEach(function (line) { console.log("  " + line); });

  try {
    const calendar = get_birthday_calendar();
    console.log("cal_id resolved OK: \"" + calendar.getName() + "\" (timezone " + calendar.getTimeZone() + ")");
  } catch (err) {
    console.error("cal_id FAILED: " + err.message);
    return;
  }

  try {
    const calendar = get_birthday_calendar();
    const range = get_one_year_window();
    const all_events = calendar.getEvents(range.start, range.end);
    const recognised = all_events.filter(function (e) { return get_people_tag(e) !== undefined; });
    console.log("Events on the birthday calendar in the next year: " + all_events.length);
    console.log("  recognised by this version: " + recognised.length);
    console.log("  NOT recognised: " + (all_events.length - recognised.length));
    if (all_events.length - recognised.length >= duplicate_guard_threshold) {
      console.warn("Unrecognised events present. If these are birthday series from an " +
                   "earlier version, run migrate_legacy_tags() to completion BEFORE the " +
                   "next update_birthdays() run, or every contact will be duplicated.");
    }
  } catch (err) {
    console.error("Calendar scan FAILED: " + err.message);
  }

  try {
    const contacts = get_contacts_with_birthdays();
    const count = Object.keys(contacts).length;
    console.log("Contacts with a birthday: " + count);
    if (max_new_series_per_run > 0 && count > max_new_series_per_run) {
      console.log(
        "First full sync will be spread across about " +
        Math.ceil(count / max_new_series_per_run) + " daily runs " +
        "(cap of " + max_new_series_per_run + " new series per run, to stay inside the " +
        "consumer Calendar write quota of roughly 500 to 1000 writes per day)."
      );
    }
  } catch (err) {
    console.error("Contact read FAILED: " + err.message);
  }
}

// ----------------------------------------------------------------------------
// Contact reading
// ----------------------------------------------------------------------------

/**
 * Read every contact that has both a display name and a birthday date.
 * @returns {Object<string, {name: string, birthday: {year?: number, month: number, day: number}}>}
 *          keyed by People API resourceName
 * @throws {Error} if the People API call fails
 */
function get_contacts_with_birthdays() {
  /** @type {Object<string, {name: string, birthday: Object}>} */
  const contacts_birthdays = {};
  let page_token = null;

  do {
    const response = People.People.Connections.list("people/me", {
      personFields: "names,birthdays",
      pageSize: 1000,
      pageToken: page_token
    });

    const connections = response.connections || [];
    connections.forEach(function (connection) {
      const names = connection.names || [];
      const birthdays = connection.birthdays || [];
      // A birthday entry can exist with no date attached; skip those.
      if (names.length > 0 && birthdays.length > 0 && birthdays[0].date !== undefined) {
        const date = birthdays[0].date;
        // month and day are mandatory for a usable recurrence.
        if (date.month !== undefined && date.day !== undefined) {
          contacts_birthdays[connection.resourceName] = {
            name: names[0].displayName,
            birthday: date
          };
        }
      }
    });

    page_token = response.nextPageToken;
  } while (page_token);

  return contacts_birthdays;
}

// ----------------------------------------------------------------------------
// Main sync
// ----------------------------------------------------------------------------

/**
 * Main entry point. Point the time-driven trigger at this function.
 * Adds, updates and removes birthday series to match Google Contacts.
 */
function update_birthdays() {
  /** @type {number} */
  const start = new Date().getTime();
  /** @type {number} */
  let new_series_added = 0;
  /** @type {boolean} */
  let hit_add_cap = false;

  try {
    const cal_birthday = get_birthday_calendar();
    if (debug) { console.time("Total execution"); }

    const timezone = cal_birthday.getTimeZone();
    const yearly = get_yearly_recurrence();
    const birthday_status = get_birthday_status();

    // --- contacts -------------------------------------------------------
    if (debug) { console.time("Getting contacts"); }
    const contacts_birthdays = get_contacts_with_birthdays();
    if (debug) {
      console.log(Object.keys(contacts_birthdays).length + " contacts with birthdays found");
      console.timeEnd("Getting contacts");
    }

    // --- existing series in the calendar --------------------------------
    // A one-year window from tomorrow captures each yearly series exactly once.
    if (debug) { console.time("Getting birthdays"); }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    nextYear.setHours(23, 59, 59, 999);

    const all_events = cal_birthday.getEvents(tomorrow, nextYear);
    const events = all_events.filter(function (e) { return get_people_tag(e) !== undefined; });
    /** Events on this calendar that this version cannot tie to a contact. */
    const unrecognised_count = all_events.length - events.length;

    /** @type {Object<string, Object>} keyed by people_id */
    const birthday_events = {};
    /** @type {Object<string, {people_id: string, event_title: string}>} keyed by event id */
    const duplicates = {};

    events.forEach(function (event) {
      const people_id = get_people_tag(event);
      const event_id = event.getId();
      const event_title = event.getTitle();
      const event_date = event.getStartTime();

      // More than one series per contact should not happen, but the calendar
      // permits it and an interrupted run can create it. Collect both sides.
      if (undefined !== birthday_events[people_id]) {
        duplicates[birthday_events[people_id]["id"]] = {
          people_id: people_id,
          event_title: birthday_events[people_id]["title"]
        };
        duplicates[event_id] = { people_id: people_id, event_title: event_title };
      }

      birthday_events[people_id] = {
        id: event_id,
        title: event_title,
        date: {
          day: event_date.getDate(),
          month: event_date.getMonth() + 1,
          year: event_date.getFullYear()
        },
        description: event.getDescription(),
        status: event.getTransparency(),
        feb29: get_feb29_tag(event)
      };
    });

    // Remove all copies of a duplicated series. There is no way to tell which
    // copy is authoritative, so both go and the correct one is re-added below.
    Object.keys(duplicates).forEach(function (event_id) {
      const duplicate = duplicates[event_id];
      try {
        require_series(cal_birthday, event_id).deleteEventSeries();
        if (debug) { console.log("Removed duplicate '" + duplicate["event_title"] + "'"); }
      } catch (err) {
        // Both ids can resolve to the same series, in which case the second
        // lookup fails after the first delete. Not fatal.
        if (debug) { console.log("Duplicate " + event_id + " already gone: " + err.message); }
      }
      delete birthday_events[duplicate["people_id"]];
    });

    if (debug) {
      console.log(Object.keys(birthday_events).length + " birthday series found in calendar");
      console.timeEnd("Getting birthdays");
    }

    // --- reconcile existing series --------------------------------------
    // Roughly 1s per removal, 0.5s per update. On timeout the run stops and
    // resumes on the next trigger.
    Object.keys(birthday_events).forEach(function (people_id) {
      const birthday = birthday_events[people_id];

      // Contact gone, or its birthday removed, so the series goes too.
      if (undefined === contacts_birthdays[people_id]) {
        if (debug) { console.time("Removing birthday series"); }
        try {
          require_series(cal_birthday, birthday.id).deleteEventSeries();
          if (debug) { console.log("Removed '" + birthday.title + "' from calendar"); }
        } catch (err) {
          console.error("Could not remove '" + birthday.title + "': " + err.message);
        }
        delete birthday_events[people_id];
        if (debug) { console.timeEnd("Removing birthday series"); }
        return;
      }

      const contact = contacts_birthdays[people_id];
      /** @type {GoogleAppsScript.Calendar.CalendarEventSeries|undefined} */
      let birthday_series = undefined;

      const contact_birthday = contact.birthday["month"] + "-" + contact.birthday["day"];
      const birthday_date = birthday.date["month"] + "-" + birthday.date["day"];

      // Feb 29 needs a BYMONTHDAY=-1 rule that setRecurrence() cannot express,
      // so any series moving onto or off Feb 29 is deleted and re-created below.
      const touches_feb29 =
        (("2-29" === contact_birthday || "2-29" === birthday_date) && !birthday.feb29) ||
        ("2-29" !== contact_birthday && (birthday.feb29 || "2-29" === birthday_date));

      if (touches_feb29) {
        if (debug) { console.time("Deleting birthday series"); }
        try {
          require_series(cal_birthday, birthday.id).deleteEventSeries();
          if (debug) {
            console.log("Deleted series for '" + contact.name + "' (Feb 29 handling), will re-add");
          }
        } catch (err) {
          console.error("Could not delete Feb 29 series for '" + contact.name + "': " + err.message);
        }
        delete birthday_events[people_id];
        if (debug) { console.timeEnd("Deleting birthday series"); }
        return;
      }

      // Ordinary date change.
      if (birthday_date !== contact_birthday && !birthday.feb29) {
        if (debug) { console.time("Modifying birthday series"); }
        try {
          if (undefined === birthday_series) {
            birthday_series = require_series(cal_birthday, birthday.id);
          }
          if (false === birthday_start_hour) {
            birthday_series.setRecurrence(yearly, get_birthday_date(contact.birthday));
          } else {
            const birthday_hours = get_birthday_hours(contact.birthday);
            birthday_series.setRecurrence(yearly, birthday_hours.start, birthday_hours.end);
          }
          if (debug) {
            console.log(
              "Moved '" + contact.name + "' from " +
              month_short[birthday.date["month"] - 1] + " " + birthday.date["day"] + " to " +
              month_short[contact.birthday["month"] - 1] + " " + contact.birthday["day"]
            );
          }
        } catch (err) {
          console.error("Could not move series for '" + contact.name + "': " + err.message);
        }
        if (debug) { console.timeEnd("Modifying birthday series"); }
      }

      // Display name changed, so the title changes.
      const new_title = get_birthday_title(contact.name);
      const new_title_age = get_birthday_title_age(
        new_title, birthday.date["year"], contact.birthday["year"]
      );
      if (birthday.title !== new_title && birthday.title !== new_title_age) {
        if (debug) { console.time("Modifying birthday series"); }
        try {
          if (undefined === birthday_series) {
            birthday_series = require_series(cal_birthday, birthday.id);
          }
          birthday_series.setTitle(new_title);
          if (debug) { console.log("Retitled '" + birthday.title + "' to '" + new_title + "'"); }
        } catch (err) {
          console.error("Could not retitle '" + birthday.title + "': " + err.message);
        }
        if (debug) { console.timeEnd("Modifying birthday series"); }
      }

      // Year of birth added, removed or corrected, so the description changes.
      const new_description = get_birthday_description(contact.birthday, timezone);
      if (birthday.description !== new_description) {
        if (debug) { console.time("Modifying birthday series"); }
        try {
          if (undefined === birthday_series) {
            birthday_series = require_series(cal_birthday, birthday.id);
          }
          birthday_series.setDescription(new_description);
          if (debug) { console.log("Updated description for '" + new_title + "'"); }
        } catch (err) {
          console.error("Could not update description for '" + new_title + "': " + err.message);
        }
        if (debug) { console.timeEnd("Modifying birthday series"); }
      }

      if (new Date().getTime() - start > exec_limit) {
        throw new Error("Exceeded maximum execution time - will resume on next run");
      }
    });

    // --- guard -----------------------------------------------------------
    // Last checkpoint before any series is created. Throws rather than writes.
    const to_create_count = Object.keys(contacts_birthdays).filter(function (people_id) {
      return undefined === birthday_events[people_id];
    }).length;
    assert_no_mass_duplication(unrecognised_count, to_create_count);
    if (debug) {
      console.log(to_create_count + " series to create, " +
                  unrecognised_count + " unrecognised event(s) on the calendar");
    }

    // --- add missing series ---------------------------------------------
    // Roughly 2s and 4 Calendar writes per series.
    Object.keys(contacts_birthdays).forEach(function (people_id) {
      if (undefined !== birthday_events[people_id]) { return; }

      if (max_new_series_per_run > 0 && new_series_added >= max_new_series_per_run) {
        hit_add_cap = true;
        return;
      }

      const contact = contacts_birthdays[people_id];
      if (debug) { console.time("Adding birthday series"); }

      try {
        /** @type {GoogleAppsScript.Calendar.CalendarEventSeries|undefined} */
        let new_series = undefined;

        if (2 === contact.birthday["month"] && 29 === contact.birthday["day"]) {
          // Feb 29: recur on the last day of February every year. The plain
          // createAllDayEventSeries cannot express BYMONTHDAY=-1, so insert via
          // the Advanced Calendar Service.
          //
          // v1.3.2 built this start date from get_birthday_date(), which rolls
          // Feb 29 forward to Mar 1 in a non-leap year and then produced an
          // invalid literal such as "2025-02-29". Anchor on a real leap year.
          const leap_year = get_recent_leap_year();
          let event_start = { date: leap_year + "-02-29" };
          let event_end = { date: leap_year + "-03-01" };

          if (false !== birthday_start_hour) {
            const hours = get_feb29_hours(leap_year);
            event_start = { dateTime: hours.start.toISOString(), timeZone: "UTC" };
            event_end = { dateTime: hours.end.toISOString(), timeZone: "UTC" };
          }

          const feb29_insert = Calendar.Events.insert({
            start: event_start,
            end: event_end,
            recurrence: ["RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=-1"],
            summary: get_birthday_title(contact.name),
            description: get_birthday_description(contact.birthday, timezone)
          }, cal_id);

          // Inserted via the Advanced Calendar Service, so it must be read back
          // through CalendarApp before tags can be attached.
          new_series = cal_birthday.getEventSeriesById(feb29_insert.iCalUID);
          if (!new_series) {
            throw new Error(
              "Feb 29 series was inserted (iCalUID " + feb29_insert.iCalUID +
              ") but could not be read back to tag it. It is now an untagged " +
              "series on the calendar and needs removing by hand."
            );
          }
          new_series.setTag(TAG_FEB29, "feb29");
        } else {
          if (false === birthday_start_hour) {
            new_series = cal_birthday.createAllDayEventSeries(
              get_birthday_title(contact.name),
              get_birthday_date(contact.birthday),
              yearly,
              { description: get_birthday_description(contact.birthday, timezone) }
            );
          } else {
            const hours = get_birthday_hours(contact.birthday);
            new_series = cal_birthday.createEventSeries(
              get_birthday_title(contact.name),
              hours.start,
              hours.end,
              yearly,
              { description: get_birthday_description(contact.birthday, timezone) }
            );
          }
        }

        // The tag is what makes this series recoverable on later runs. If it
        // fails, the series becomes an orphan and would be duplicated next run,
        // so remove it and let the next run try again cleanly.
        try {
          new_series.setTag(TAG_BIRTHDAY, people_id);
        } catch (tag_err) {
          try { new_series.deleteEventSeries(); } catch (cleanup_err) { /* best effort */ }
          throw new Error("Could not tag new series, rolled it back: " + tag_err.message);
        }

        new_series.setTransparency(birthday_status);
        if (false !== birthday_reminder_minutes) {
          new_series.addPopupReminder(Number(birthday_reminder_minutes));
        }

        new_series_added++;
        if (debug) { console.log("Added birthday series for '" + contact.name + "'"); }
      } catch (err) {
        console.error("Could not add series for '" + contact.name + "': " + err.message);
      }

      if (debug) { console.timeEnd("Adding birthday series"); }

      if (new Date().getTime() - start > exec_limit) {
        throw new Error("Exceeded maximum execution time - will resume on next run");
      }
    });

    // --- age suffix on the next occurrence -------------------------------
    // Separate pass: getEventSeriesById returns the series, not the individual
    // occurrence, so the occurrence titles are set here once everything exists.
    const next_birthdays = cal_birthday.getEvents(tomorrow, nextYear)
      .filter(function (e) { return get_people_tag(e) !== undefined; });

    next_birthdays.forEach(function (event) {
      const people_id = get_people_tag(event);
      const contact = contacts_birthdays[people_id];

      // Guard: an orphaned tag (contact deleted mid-run) would otherwise throw
      // a TypeError here and abort the whole pass. v1.3.2 dereferenced blind.
      if (!contact) {
        if (debug) { console.log("Skipping orphaned event '" + event.getTitle() + "' (" + people_id + ")"); }
        return;
      }

      const base_title = get_birthday_title(contact.name);
      const title_with_age = get_birthday_title_age(
        base_title, event.getStartTime().getFullYear(), contact.birthday["year"]
      );
      const event_title = event.getTitle();

      if (title_with_age !== event_title) {
        try {
          event.setTitle(title_with_age);
          if (debug) { console.log("Retitled next occurrence to '" + title_with_age + "'"); }
        } catch (err) {
          console.error("Could not retitle occurrence '" + event_title + "': " + err.message);
        }
      }

      if (new Date().getTime() - start > exec_limit) {
        throw new Error("Exceeded maximum execution time - will resume on next run");
      }
    });

    if (debug) { console.timeEnd("Total execution"); }

    // --- notifications ---------------------------------------------------
    const contact_count = Object.keys(contacts_birthdays).length;
    // Count distinct series, not occurrences. v1.3.2 reported occurrence count.
    const series_count = Object.keys(next_birthdays.reduce(function (acc, e) {
      acc[get_people_tag(e)] = true;
      return acc;
    }, {})).length;

    if (hit_add_cap) {
      const remaining = contact_count - series_count;
      const message =
        "This run added the maximum of " + max_new_series_per_run + " new birthday series and stopped " +
        "deliberately, to stay inside the daily Google Calendar write quota.\n\n" +
        "Roughly " + (remaining > 0 ? remaining : 0) + " contacts still need a series. The next " +
        "scheduled run will continue where this one stopped. No action needed.";
      if (debug) { console.log(message); } else { notify("Info: Birthday Calendar - continuing tomorrow", message); }
    }

    // Monthly sign of life, sent after the run on the last day of the month.
    const now = new Date();
    const last_day = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    if (last_day.getDate() === now.getDate() && !debug) {
      notify(
        "Update: Google Script - Birthday Calendar",
        "Hello,\n\n" +
        "If you have not heard from me for a month, everything is fine and your contacts' " +
        "birthdays are being synced to your calendar once a day.\n\n" +
        "You currently have " + contact_count + " contacts with birthdays and " +
        series_count + " birthday series in your calendar.\n\n" +
        "---\n\n" +
        "You are currently using v" + version + " of this script. Check the project page " +
        "occasionally for updates.\n" +
        "https://github.com/Ryan-Adams57/Google-Contacts-Birthday-Calendar"
      );
    }

  } catch (error) {
    const timed_out = ("Exceeded maximum execution time - will resume on next run" === error.message);

    if (debug) {
      console.error(error.message);
      if (error.stack) { console.error(error.stack); }
      return;
    }

    notify(
      "Error: Google Script - Birthday Calendar",
      "Unfortunately, an error happened upon syncing your contacts' birthdays with your calendar:\n\n" +
      error.message + "\n\n" +
      (timed_out
        ? "The script did not get through all birthdays this time, because of Google's execution " +
          "time limit. It will continue where it stopped on the next run later today."
        : "Run the verify_setup() function in the Apps Script editor. It reports which Google " +
          "account the script is authorized as, which calendars that account owns, and whether " +
          "your cal_id resolves. That identifies almost every cause of this error.\n\n" +
          "Project page: https://github.com/Ryan-Adams57/Google-Contacts-Birthday-Calendar\n" +
          "Script version: v" + version) + "\n\n" +
      "New series created before this run stopped: " + new_series_added
    );
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Build the event title from the contact's display name.
 * @param {string} contact_name
 * @returns {string}
 */
function get_birthday_title(contact_name) {
  return (birthday_title.indexOf("%s") !== -1)
    ? birthday_title.replace("%s", contact_name)
    : contact_name;
}

/**
 * Append the contact's age at the time of the event, when the year is known.
 * @param {string} title
 * @param {number} event_year
 * @param {number|undefined} birth_year
 * @returns {string}
 */
function get_birthday_title_age(title, event_year, birth_year) {
  return (undefined !== birth_year && Number(birth_year) > Number(birthday_description_ignore_before))
    ? title + " (" + (event_year - birth_year) + ")"
    : title;
}

/**
 * Series anchor date: the contact's birthday in last year, so the recurrence
 * already covers the current year.
 * @param {{month: number, day: number}} contact_birthday
 * @returns {Date}
 */
function get_birthday_date(contact_birthday) {
  const today = new Date();
  return new Date((today.getFullYear() - 1), (contact_birthday["month"] - 1), contact_birthday["day"]);
}

/**
 * Start and end of a one-hour birthday event.
 * @param {{month: number, day: number}} contact_birthday
 * @returns {{start: Date, end: Date}}
 */
function get_birthday_hours(contact_birthday) {
  const birthday_start = get_birthday_date(contact_birthday);
  birthday_start.setHours(Number(birthday_start_hour), 0, 0, 0);
  const birthday_end = get_birthday_date(contact_birthday);
  birthday_end.setHours(Number(birthday_start_hour) + 1, 0, 0, 0);
  return { start: birthday_start, end: birthday_end };
}

/**
 * Start and end of a one-hour Feb 29 event, anchored on a real leap year.
 * @param {number} leap_year
 * @returns {{start: Date, end: Date}}
 */
function get_feb29_hours(leap_year) {
  const start = new Date(leap_year, 1, 29);
  start.setHours(Number(birthday_start_hour), 0, 0, 0);
  const end = new Date(leap_year, 1, 29);
  end.setHours(Number(birthday_start_hour) + 1, 0, 0, 0);
  return { start: start, end: end };
}

/**
 * Most recent leap year at or before last year. Used to anchor a Feb 29 series
 * on a date that actually exists.
 * @returns {number}
 */
function get_recent_leap_year() {
  let year = new Date().getFullYear() - 1;
  while (!is_leap_year(year)) { year--; }
  return year;
}

/**
 * @param {number} year
 * @returns {boolean}
 */
function is_leap_year(year) {
  return (0 === year % 4 && 0 !== year % 100) || (0 === year % 400);
}

/**
 * Event description holding the date of birth, when the year is known and above
 * the ignore threshold.
 * @param {{year?: number, month: number, day: number}} contact_birthday
 * @param {string} timezone
 * @returns {string}
 */
function get_birthday_description(contact_birthday, timezone) {
  if (undefined === contact_birthday["year"] ||
      Number(contact_birthday["year"]) <= Number(birthday_description_ignore_before)) {
    return "";
  }
  return Utilities.formatDate(
    new Date(contact_birthday["year"], (contact_birthday["month"] - 1), contact_birthday["day"]),
    timezone,
    birthday_description_format
  );
}

// ----------------------------------------------------------------------------
// Teardown
// ----------------------------------------------------------------------------

/**
 * Count, without deleting, the birthday series this script owns. Run this before
 * delete_birthdays() to confirm the target set.
 */
function delete_birthdays_dry_run() {
  try {
    const cal_birthday = get_birthday_calendar();
    const range = get_one_year_window();
    const events = cal_birthday.getEvents(range.start, range.end)
      .filter(function (e) { return get_people_tag(e) !== undefined; });

    console.log("DRY RUN. Calendar: \"" + cal_birthday.getName() + "\"");
    console.log("Series tagged \"" + TAG_BIRTHDAY + "\" that would be deleted: " + events.length);
    events.slice(0, 20).forEach(function (e) { console.log("  " + e.getTitle()); });
    if (events.length > 20) { console.log("  ... and " + (events.length - 20) + " more"); }
    console.log("Nothing was deleted. Run delete_birthdays() to delete for real.");
  } catch (error) {
    console.error(error.message);
  }
}

/**
 * Delete every birthday series this script created. Destructive.
 * Only touches events carrying the TAG_BIRTHDAY tag, so hand-made events on the
 * same calendar are left alone. Run delete_birthdays_dry_run() first.
 */
function delete_birthdays() {
  const start = new Date().getTime();
  let deleted = 0;

  try {
    const cal_birthday = get_birthday_calendar();
    if (debug) { console.time("Deleting birthdays"); }

    const range = get_one_year_window();
    const events = cal_birthday.getEvents(range.start, range.end)
      .filter(function (e) { return get_people_tag(e) !== undefined; });

    console.log("Deleting " + events.length + " birthday series from \"" + cal_birthday.getName() + "\"");

    for (let i = 0; i < events.length; i++) {
      const event_title = events[i].getTitle();
      try {
        require_series(cal_birthday, events[i].getId()).deleteEventSeries();
        deleted++;
        if (debug) { console.log("Deleted '" + event_title + "'"); }
        // Pace the deletes against the Calendar write quota.
        Utilities.sleep(500);
      } catch (err) {
        console.error("Could not delete '" + event_title + "': " + err.message);
      }

      if (new Date().getTime() - start > exec_limit) {
        console.log("Deleted " + deleted + " of " + events.length +
                    ". Hit the execution time limit, run delete_birthdays() again to finish.");
        return;
      }
    }

    console.log("Deleted " + deleted + " series. Re-run delete_birthdays_dry_run() to confirm zero remain.");
    if (debug) { console.timeEnd("Deleting birthdays"); }
  } catch (error) {
    console.error(error.message);
  }
}

/**
 * Tomorrow 00:00 through one year ahead 23:59. A yearly series appears exactly
 * once in this window.
 * @returns {{start: Date, end: Date}}
 */
function get_one_year_window() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setFullYear(end.getFullYear() + 1);
  end.setHours(23, 59, 59, 999);

  return { start: start, end: end };
}
