const axios = require("axios");
const cheerio = require("cheerio");

// The names of the Airtable fields representing the last notified timestamp
// based on notification type.
const timestampFieldName = {
  EMAIL: "last_email",
  PHONE: "last_call",
};
// The names of the Airtable fields representing the user's desired threshold
// in between successive notifications.
const thresholdFieldName = {
  EMAIL: "min_email_threshold",
  PHONE: "min_call_threshold",
};

const sendEmail = async (apiKey, fromEmail, email, message) => {
  var data = JSON.stringify({
    personalizations: [{ to: [{ email: email }] }],
    from: { email: fromEmail },
    subject: `Retail Pharmacy COVID-19 Vaccine Availability Status Report: ${new Date().toGMTString()}`,
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

  let retailers = Object.entries(statuses).map((retailer) => {
    let citiesPhrase = Object.keys(retailer[1]);
    if (citiesPhrase.length > 1) {
      citiesPhrase[citiesPhrase.length - 1] = "and " + citiesPhrase[citiesPhrase.length - 1];
    }

    return `${retailer[0]} locations in ${citiesPhrase}.`
  })

  if (retailers.length > 1) {
    retailers.splice(retailers.length - 1, 0, 'and');
  }

  const locationPhrase =
    encodeURIComponent(retailers.join(' '));

  try {
    return await twilioClient.calls.create({
      from: fromNumber,
      to: number,
      url: `https://handler.twilio.com/twiml/${twimlBinId}?name=${name}&locations=${locationPhrase}`,
    });
  } catch (error) {
    console.log(error);
  }
};

// Converts an array of availabilities into a basic HTML email for display
const convertHTML = (user, statuses) => {
  let locationBlocks = "";

  Object.entries(statuses).forEach((retailer) => {

    let cityBlocks = "";
    Object.entries(retailer[1]).forEach((city) => {
      cityBlocks += `${city[0]}: ${city[1].join(', ')}<br />`
    })

    locationBlocks += `
      <hr>
      <h2>${retailer[0]}</h2>
      <p>${cityBlocks}</p>
    `;
  });

  const storePreferencePhrase = (user.store_preference && JSON.parse(user.store_preference).length > 0) ? `Based on your user preference, we are only monitoring the following stores: ${JSON.parse(user.store_preference).join(", ")}` : "Based on your user preference, we are monitoring all retailers (CVS, Rite-Aid, and Walgreens)";

  return `
    <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
      <html xmlns="http://www.w3.org/1999/xhtml" lang="en-GB">
      <head>
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
          <title>Retail Pharmacy COVID-19 Vaccine Availabilities</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      </head>
      <h1>Retail Pharmacy COVID-19 Vaccine Availabilities for ${user.name}</h1>
      <h2>Check GetMyVaccine for more info: <a href="https://www.getmyvaccine.org/zips/${user.zipcode}">https://www.getmyvaccine.org/zips/${user.zipcode}</a></h2>
      <p>We detected new availabilities for pharmacies within <strong>${user.distance} miles</strong> from <strong>${user.zipcode}</strong>. ${storePreferencePhrase}</p>
      ${locationBlocks}

      <hr>
      <small>Based on your user preferences, we will not e-mail you again for another ${user.min_email_threshold} minutes, even if more availabilities open up.</small>

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
        [timestampFieldName["PHONE"]]: user.fields[timestampFieldName["PHONE"]],
        [timestampFieldName["EMAIL"]]: user.fields[timestampFieldName["EMAIL"]],
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
// If 1) There are availabilities for the user profile
//    2) Enough time has passed since the last notification (per user preferences)
// Then
//    Trigger a Twilio API or SendGrid API call to email/call the user
const processNotification = async (
  timestamp,
  context,
  user,
  userLocationAvailabilities,
  notificationType
) => {
  // When did we last notify user?
  const userTimeStamp = user[timestampFieldName[notificationType]];

  // How often does the user want to be notified?
  const userThreshold = user[thresholdFieldName[notificationType]]

  // Calculate time since last notification
  //  (Current runtime invocation timestamp - last notification timestamp)
  const deltaInMinutes = (userTimeStamp) => Math.round(
    (timestamp.getTime() -
      new Date(userTimeStamp)) /
    60000
  );

  const hasAvailabilities = Object.entries(userLocationAvailabilities).length > 0;

  // If user timestamp is undefined, we've never sent them a notification, so send them a notification now for the first time.
  // If user threshold is undefined, send a notification as there is no preference to back off successive notifications.
  //
  // If user threshold is defined and we've sent them a notification before, compare with threshold preference to ensure time difference.
  const timeThresholdMet = !userThreshold || !userTimeStamp || (deltaInMinutes(userTimeStamp) > userThreshold);

  if (
    (hasAvailabilities && timeThresholdMet) ||
    (context.DEBUG_MODE === "true")
  ) {
    switch (notificationType) {
      case "EMAIL":
        // Only attempt to send email if one is defined for user
        if (user.email && user.email.length > 0) {
          await sendEmail(
            context.SENDGRID_API_KEY,
            context.SENDGRID_SENDER,
            user.email.trim(),
            convertHTML(user, userLocationAvailabilities)
          );
          return Promise.resolve(new Date().toISOString());
        } else {
          return Promise.resolve(user[timestampFieldName[notificationType]]);
        }
      case "PHONE":
        // Only attempt to call phone if one is defined for user
        if (user.phone && user.phone.length > 0) {
          await callTwilio(
            context.getTwilioClient(),
            context.TWILIO_TWIML_BIN_ID,
            context.TWILIO_PHONE_NUMBER,
            user.name,
            user.phone.trim(),
            userLocationAvailabilities
          );
          return Promise.resolve(new Date().toISOString());
        } else {
          return Promise.resolve(user[timestampFieldName[notificationType]]);
        }
    }
  } else {
    // Return old timestamp since we are not sending notitifcation or
    // updating user object.
    return Promise.resolve(user[timestampFieldName[notificationType]]);
  }
};

// Process all users and send notifications if criteria is met.
// Loops through all users we have and processes email and phone alerts.
// Users will be notified if:
//    1) There are availabilities for their user profile.
//    2) Enough time has passed since our last notification per user preferences.
//       This is to avoid calling a phone every 5 mins if there is a 60 minute window
//       during which there are open appointment availabilities.
const processUsers = async (context, users, timestamp,) => {
  const userPromises = users.map(async (user) => {
    return await processUser(timestamp, context, user.fields);
  });

  // Wait for all users to be processed and then return the users array, which
  // will have their updated timestamps if the user was notified via phone/email
  await Promise.all(userPromises);

  return users;
};

// Returns array of locations if available for user
// Returns empty array if none found
const filterResultsForUser = (results, user, timestamp) => {

  // If no user distance preference is defined, don't filter anything.
  // Otherwise, ensure the location is within range.
  const isWithinRange = (locationDistance, userDistancePreference) => {
    return !userDistancePreference || (locationDistance < userDistancePreference);
  }

  // If no user store preference is defined, don't filter anything.
  // Otherwise, ensure this location is one of the user's desired retail pharmacies.
  const isPreferredStore = (store, userStorePreference) => {
    return (!userStorePreference || JSON.parse(userStorePreference).length === 0) || JSON.parse(userStorePreference).includes(store);
  }

  // If no user data freshness preference is defined, don't filter anything.
  // Otherwise, make sure the data collection time is within the user's preference.
  const isFresh = (dataCollectionTime, userDataFreshnessPreference) => {
    return (!userDataFreshnessPreference) || (Math.abs(Math.round((timestamp - dataCollectionTime) / 60000)) <= userDataFreshnessPreference);
  }

  // Each retailer has a different key in their schema
  const hasAppointments = (loc) => {
    // CVS schema should have a key `available_slots` with a number, but it seems like the actual interpretation
    // should be that the presence of a CVS record means that there is an availability, so bypass a check.
    return loc.store === "cvs" || loc.appointments_available || (loc.slots_1 || loc.slots_2);
  }

  const availabilityData = (results && results.zips && results.zips.length > 0) ? results.zips : [];

  return availabilityData
    .filter((loc) => {
      return (
        hasAppointments(loc) &&
        isFresh(new Date(loc.collection_date), user.data_freshness) &&
        isPreferredStore(loc.store, user.store_preference) &&
        isWithinRange(loc.distance, user.distance)
      );
    })
    .map((loc) => {
      return {
        store: loc.store.replace("_", " "),
        city: loc.city,
        state: loc.state,
        zipcode: loc.zip || loc.zips,
      };
    });
};

// Quick optimization to not fetch data unless we need to. 
// If neither timestamps (phone/email) have met their time thresholds, skip this user.
const shouldFetchData = (timestamp, user) => {
  // if no email defined  => email not eligible
  //
  // if email defined AND no min_email_threshold defined => email eligible (always send email because no threshold is defined)
  // if email defined AND no last_email defined => eligible (we've never sent them an email)
  // if email defined AND min_email_threshold defined
  //    AND     time - last_email > threshold   => eligible (we've sent them email + enough time has passed)
  const emailEligible = user.email !== undefined && (
    (!user[thresholdFieldName['EMAIL']] || (Math.round(
      (timestamp.getTime() -
        new Date(user[timestampFieldName['EMAIL']])) /
      60000
    )) >= user[thresholdFieldName['EMAIL']]) || !user[timestampFieldName['EMAIL']]
  );

  // if no phone defined  => phone not eligible
  //
  // if phone defined AND no min_phone_threshold defined => phone eligible (always call phone because no threshold is defined)
  // if phone defined AND no last_phone defined => eligible (we've never sent them an phone)
  // if phone defined AND min_phone_threshold defined
  //    AND     time - last_phone > threshold   => eligible (we've sent them phone + enough time has passed)
  const phoneEligible = user.phone !== undefined && (
    (!user[thresholdFieldName['PHONE']] || (Math.round(
      (timestamp.getTime() -
        new Date(user[timestampFieldName["PHONE"]])) /
      60000
    )) >= user[thresholdFieldName['PHONE']]) || !user[timestampFieldName['PHONE']]
  );

  // If either are eligible, then we should fetch data and attempt to find appointments.
  return emailEligible || phoneEligible;
}


const getGMVData = async (zipcode) => {
  try {
    return await axios({
      method: "get",
      url: `https://www.getmyvaccine.org/zips/${zipcode}`,
    }).then((response) => {
      // API endpoint changes with each site deploy, so need to parse HTML response of index page
      const $ = cheerio.load(response.data);
      const nextData = $('html').find("#__NEXT_DATA__").contents().first().text();
      return JSON.parse(nextData).props.pageProps;
    });
  } catch (error) {
    console.log(error);
  }
}

const processUser = async (timestamp, context, user) => {
  // If time thresholds haven't been met for neither phone nor email, don't even attempt to fetch data.
  if (!shouldFetchData(timestamp, user) && !context.DEBUG_MODE) {
    return Promise.resolve(null)
  }

  // Get GMV Vaccine data based on user preferences
  const results = await getGMVData(user.zipcode);

  // Filter based on locations data with user preference
  const availabilities = filterResultsForUser(results, user, timestamp);

  // Since these are generic retail pharmacy locations that can share a zipcode, 
  //  we need to collapse if the locations to make it easy to display on email and speak over phone.
  // 
  // Output format is:    
  // consolidatedLocations: { walgreens: { 'CityName': [12345, 67890], 'Cityname2' : [12345] }, cvs: { 'City3Name': [78901] } }
  const consolidatedLocations = availabilities.reduce(
    (memo, l) => {
      memo[l.store] ? (memo[l.store][l.city] ? memo[l.store][l.city].push(l.zipcode) : memo[l.store][l.city] = [l.zipcode]) : memo[l.store] = { [l.city]: [l.zipcode] };
      return memo;
    }, {}
  )

  // Process Email Notification
  // emailTimestamp will either
  //  1) return the old last-emailed timestamp if no notification was triggered
  //  2) return a new updated timestamp if a notification was triggered + delivered
  const emailTimestamp = await processNotification(
    timestamp,
    context,
    user,
    consolidatedLocations,
    "EMAIL"
  );

  // // Update the user's last emailed timestamp based on the result of processNotification
  user.last_email = emailTimestamp;

  // // Process Phone Notification
  // // phoneTimestamp will either
  // //  1) return the old last-called timestamp if no notification was triggered
  // //  2) return a new updated timestamp if a notification was triggered + delivered
  const phoneTimestamp = await processNotification(
    timestamp,
    context,
    user,
    consolidatedLocations,
    "PHONE"
  );
  // // Update the user's last called timestamp based on the result of processNotification
  user.last_call = phoneTimestamp;

  return Promise.resolve(user);
};

exports.handler = async function (context, event, callback) {
  // Get all users from Airtable that need to be processed
  let users = await getUsers(context);

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
    runtimeTimestamp,
  );

  // // Update Airtable with all user definitions.
  // // We're mutating users... so just re-upload that payload
  await updateUserInfo(context, processedUsers);

  // Twilio Function default response
  return callback(null, "Success");
};
