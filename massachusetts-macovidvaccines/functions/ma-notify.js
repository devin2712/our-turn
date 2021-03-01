const axios = require("axios");

const sendEmail = async (apiKey, fromEmail, email, message) => {
  var data = JSON.stringify({
    personalizations: [{ to: [{ email: email }] }],
    from: { email: fromEmail },
    subject: `MA COVID-19 Vaccine Availability Status Report: ${new Date().toGMTString()}`,
    content: [{ type: "text/html", value: message }],
  });

  try {
    return await axios({
      method: "post",
      url: "https://api.sendgrid.com/v3/mail/send",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      data: data,
    });
  } catch (error) {
    console.log(error);
  }
};

const callTwilio = async (
  twilioClient,
  twimlBinId,
  fromNumber,
  name,
  number,
  statuses
) => {
  // Compute total number of slots in availabilities to dictate over the phone
  const numOfSlots = statuses.reduce(
    (memo, s) => (memo = memo + (s.numberOfSlots || 0)),
    0
  );
  // Generate call phrase for speech-to-text to read out the list of
  // available locations. This is just adding an `and` after the penultimate
  // location if there are multiple locations.
  let locations = statuses.map((loc) => loc.name);
  if (locations.length > 1) {
    locations.splice(locations.length - 1, 0, "and");
  }
  const locationPhrase = encodeURIComponent(locations.join(", "));

  try {
    return await twilioClient.calls.create({
      from: fromNumber,
      to: number,
      url: `https://handler.twilio.com/twiml/${twimlBinId}?name=${name}&number=${numOfSlots}&locations=${locationPhrase}`,
    });
  } catch (error) {
    console.log(error);
  }
};

// Returns array of location data summaries for desired `locations`
const filterLocations = (context, locations, results) => {
  const locationsData = results.filter((loc) => locations.includes(loc.name));

  // If any valid locations found (names match)
  if (locationsData.length > 0) {
    return locationsData
      .map((loc) => {
        // hasAvailability key has been unreliable, so double-check availability
        const totalAvailabilities = Object.values(loc.availability).reduce(
          (memo, value) => (memo = memo + value["numberAvailableAppointments"]),
          0
        );
        const hasAvailability =
          Object.keys(loc.availability).length > 0 && totalAvailabilities > 0;

        // If Debug mode is true, we will return location data even if there are no appointments, which will
        //  always trigger a notification.
        if (hasAvailability || context.DEBUG_MODE === "true") {
          return {
            name: loc.name,
            address: `${loc.street} ${loc.city} ${loc.state}`,
            hasAvailability: hasAvailability,
            availability: loc.availability,
            numberOfSlots: totalAvailabilities,
            signUpLink: loc.signUpLink,
          };
        }
      })
      .filter((obj) => obj);
  } else {
    return [];
  }
};

// Converts an array of availabilities into a basic HTML email for display
const convertHTML = (statuses) => {
  let locationBlocks = "";

  statuses.forEach((location) => {
    let availableBlocks = "";

    Object.entries(location.availability).forEach((a) => {
      if (a[1].numberAvailableAppointments > 0) {
        availableBlocks += `
              <h3>Date: ${a[0]}</h3>
              <h3>Info: ${JSON.stringify(a[1])}</h3>
              <h3>Link: <a href="${a[1].signUpLink}">${a[1].signUpLink}</a></h3>
            `;
      }
    });

    locationBlocks += `
          <hr>
          <h2>${location.name}</h2>
          <h4>Address (if available): ${location.address}<br />Location Link (if available): ${location.signUpLink}</h4>
          ${availableBlocks}
        `;
  });

  return `
    <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
      <html xmlns="http://www.w3.org/1999/xhtml" lang="en-GB">
      <head>
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
          <title>MA COVID-19 Vaccine Availabilities</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      </head>
      <h1>MA COVID-19 Vaccine Availabilities</h1>
      <h2>Quick Links</h2>
      <p>
        <a href="https://www.maimmunizations.org/clinic/search?q%5Bservices_name_in%5D%5B%5D=Vaccination&location=&search_radius=All&q%5Bvenue_search_name_or_venue_name_i_cont%5D=fenway&q%5Bclinic_date_gteq%5D=&q%5Bvaccinations_name_i_cont%5D=&commit=Search#search_results"><h3>Fenway Index page</h3></a>
        <a href="https://www.maimmunizations.org/clinic/search?q%5Bservices_name_in%5D%5B%5D=Vaccination&location=&search_radius=All&q%5Bvenue_search_name_or_venue_name_i_cont%5D=reggie+lewis&q%5Bclinic_date_gteq%5D=&q%5Bvaccinations_name_i_cont%5D=&commit=Search#search_results"><h3>Reggie Lewis Index page</h3></a>
      </p>
      ${locationBlocks}
    </html>
  `;
};

// Query Airtable for the list of users to process
const getUsers = async (context) => {
  try {
    return await axios({
      method: "get",
      url: `${context.AIRTABLE_API_ENDPOINT}`,
      headers: {
        Authorization: `Bearer ${context.AIRTABLE_API_KEY}`,
      },
    }).then((response) => {
      return response.data.records;
    });
  } catch (error) {
    console.log(error);
  }
};

// Query MA COVID vaccines to get latest status on availabilities
const getVaccineInfo = async () => {
  const response = axios
    .get("https://mzqsa4noec.execute-api.us-east-1.amazonaws.com/prod")
    .then((result) => {
      return JSON.parse(result.data.body).results;
    });

  return await response;
};

// Update Airtable users
// Used to update last email send time and last phone send time
const updateUserInfo = async (context, users) => {
  // Given a list of users, just filter out so we have the User ID and timestamps
  // and send this bare minimum scope as payload because we will never be
  // updating the other fields via Airtable API (name, phone, email)
  const usersFilteredByTimestamps = users.map((user) => {
    return {
      id: user.id,
      fields: {
        "Last Call": user.fields["Last Call"],
        "Last Email": user.fields["Last Email"],
      },
    };
  });

  return await axios({
    method: "patch",
    url: `${context.AIRTABLE_API_ENDPOINT}`,
    headers: {
      Authorization: `Bearer ${context.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    data: JSON.stringify({
      records: usersFilteredByTimestamps,
    }),
  });
};

// Process a phone notification alert for a single user (if needed)
// If 1) There are availabilities in the locations the user is tracking
//    2) Enough time has passed since the last notification (per user preferences)
// Then
//    Trigger a Twilio API or SendGrid API call to email/call the user
const processNotification = async (
  timestamp,
  context,
  userInfo,
  userLocationAvailabilities,
  notificationType
) => {
  // The names of the Airtable fields representing the last notified timestamp
  // based on notification type.
  const timestampFieldName = {
    EMAIL: "Last Email",
    PHONE: "Last Call",
  };
  // The names of the Airtable fields representing the user's desired threshold
  // in between successive notifications.
  const thresholdFieldName = {
    EMAIL: "Min Minutes Between Emails",
    PHONE: "Min Minutes Between Calls",
  };

  // When did we last notify user?
  const userTimeStamp = userInfo[timestampFieldName[notificationType]];

  // How often does the user want to be notified?
  const userThreshold = userInfo[thresholdFieldName[notificationType]]

  // Calculate time since last notification
  //  (Current runtime invocation timestamp - last notification timestamp)
  const deltaInMinutes = (userTimeStamp) => Math.round(
    (timestamp.getTime() -
      new Date(userTimeStamp)) /
    60000
  );

  const hasAvailabilities = userLocationAvailabilities.length > 0;

  // If user timestamp is undefined, we've never sent them a notification, so send them a notification now for the first time.
  // If user threshold is undefined, send a notification as there is no preference to back off successive notifications.
  //
  // If user threshold is defined and we've sent them a notification before, compare with threshold preference to ensure time difference.
  const timeThresholdMet = !userThreshold || !userTimeStamp || (deltaInMinutes(userTimeStamp) > userThreshold);

  // Trigger notification if time window threshold has been met and there are availabilities.
  if ((hasAvailabilities && timeThresholdMet) || (context.DEBUG_MODE === "true")) {
    switch (notificationType) {
      case "EMAIL":
        // Only attempt to send email if one is defined for user
        if (userInfo.Email && userInfo.Email.length > 0) {
          await sendEmail(
            context.SENDGRID_API_KEY,
            context.SENDGRID_SENDER,
            userInfo.Email,
            convertHTML(userLocationAvailabilities)
          );
          // Returns new timestamp of when the new notification was sent
          return Promise.resolve(new Date().toISOString());
        } else {
          return Promise.resolve(userInfo[timestampFieldName[notificationType]]);
        }
      case "PHONE":
        // Only attempt to call phone if one is defined for user
        if (userInfo["Phone Number"] && userInfo["Phone Number"].length > 0) {
          await callTwilio(
            context.getTwilioClient(),
            context.TWILIO_TWIML_BIN_ID,
            context.TWILIO_PHONE_NUMBER,
            userInfo.Name,
            userInfo["Phone Number"],
            userLocationAvailabilities
          );
          // Returns new timestamp of when the new notification was sent
          return Promise.resolve(new Date().toISOString());
        } else {
          return Promise.resolve(userInfo[timestampFieldName[notificationType]]);
        }
    }
  } else {
    // Return old timestamp since we are not sending notification or
    // updating user object.
    return Promise.resolve(userInfo[timestampFieldName[notificationType]]);
  }
};

// Process all users and send notifications if criteria is met.
// Loops through all users we have and processes email and phone alerts.
// Users will be notified if:
//    1) There are availabilities in the locations they are tracking
//    2) Enough time has passed since our last notification per user preferences.
//       This is to avoid calling a phone every 5 mins if there is a 60 minute window
//       during which there are open appointment availabilities.
const processUsers = async (context, users, vaxData, timestamp) => {
  const userPromises = users.map(async (user) => {
    const userInfo = user.fields;

    const userDesiredLocations = userInfo.Locations ? JSON.parse(userInfo.Locations) : [];
    const userLocationAvailabilities = filterLocations(
      context,
      userDesiredLocations,
      vaxData
    );

    // Process Email Notification
    // emailTimestamp will either
    //  1) return the old last-emailed timestamp if no notification was triggered
    //  2) return a new updated timestamp if a notification was triggered + delivered
    const emailTimestamp = await processNotification(
      timestamp,
      context,
      userInfo,
      userLocationAvailabilities,
      "EMAIL"
    );
    // Update the user's last emailed timestamp based on the result of processNotification
    user.fields["Last Email"] = emailTimestamp;

    // Process Phone Notification
    // phoneTimestamp will either
    //  1) return the old last-called timestamp if no notification was triggered
    //  2) return a new updated timestamp if a notification was triggered + delivered
    const phoneTimeStamp = await processNotification(
      timestamp,
      context,
      userInfo,
      userLocationAvailabilities,
      "PHONE"
    );
    // Update the user's last called timestamp based on the result of processNotification
    user.fields["Last Call"] = phoneTimeStamp;
  });

  // Wait for all users to be processed and then return the users array, which
  // will have their updated timestamps if the user was notified via phone/email
  await Promise.all(userPromises);

  return users;
};

exports.handler = async function (context, event, callback) {
  // Get all users from Airtable that need to be processed
  let users = await getUsers(context);

  // Get data from covid scraper
  const vaxData = await getVaccineInfo();

  // Runtime timestamp (going to just reuse when setting the "last called" and "last email" times)
  const runtimeTimestamp = new Date();

  // Collect all user profiles after processing.
  // We are (ah!) mutating the users array and updating their last send times if needed
  // and then sending this payload to airtable at the end to bulk update.
  //
  // NOTE: Airtable has a 10 record limit on these calls, so would need to be updated
  // to support more users.
  const processedUsers = await processUsers(
    context,
    users,
    vaxData,
    runtimeTimestamp
  );

  // Update Airtable with all user definitions.
  // We're mutating users... so just re-upload that payload
  await updateUserInfo(context, processedUsers);

  // Twilio Function default response
  return callback(null, "Success");
};
