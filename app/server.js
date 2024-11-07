require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Middleware setup
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json()); // To parse JSON request bodies
app.use(express.static('public'));

app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true
}));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Mongoose User Schema
const userSchema = new mongoose.Schema({
  email: String,
  password: String,
  confirmed: Boolean,
  apiResponse: mongoose.Schema.Types.Mixed,  // Store API response as a JSON object
  screenshots: [{
    url: String,
    takenAt: Date
  }]
});

const User = mongoose.model('User', userSchema);

// Mongoose Queued Screenshot Schema
const queuedScreenshotSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  url: String,
  apiKey: String,
  numScreenshots: Number,
  interval: Number,
  status: { type: String, default: 'queued' },
  isLocked: { type: Boolean, default: false },  // Added lock field to prevent concurrent processing
  queuedAt: { type: Date, default: Date.now }
});

const QueuedScreenshot = mongoose.model('QueuedScreenshot', queuedScreenshotSchema);

// Nodemailer setup with Outlook
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false, // true for SSL, false for STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Verify the connection configuration
transporter.verify((error, success) => {
  if (error) {
    console.error('Outlook SMTP configuration error:', error);
  } else {
    console.log('Outlook SMTP is configured correctly');
  }
});

// Function to save a screenshot URL
async function saveScreenshot(userId, screenshotUrl) {
  await User.findByIdAndUpdate(userId, {
    $push: {
      screenshots: { url: screenshotUrl, takenAt: new Date() }
    }
  });
}

// Function to update the queued job in the database
async function updateQueuedJob(jobId, numScreenshots) {
  await QueuedScreenshot.findByIdAndUpdate(jobId, {
    numScreenshots
  });
}

// Function to delete the queued job from the database
async function deleteQueuedJob(jobId) {
  await QueuedScreenshot.findByIdAndDelete(jobId);
}

// Function to execute a screenshot job
async function executeJob(job) {
  try {
    if (job.isLocked || job.numScreenshots <= 0) {
      console.log('Job is already being processed or no screenshots left:', job._id);
      return;
    }

    // Lock the job to prevent multiple executions
    await QueuedScreenshot.findByIdAndUpdate(job._id, { isLocked: true });

    console.log('Executing job:', job);
    for (let i = 0; i < job.numScreenshots; i++) {
      const requestBody = {
        url: job.url,
        apiKey: job.apiKey
      };

      try {
        const response = await axios.post('https://cqm5bqughe.execute-api.eu-west-3.amazonaws.com/free/source', {
          body: JSON.stringify(requestBody)
        }, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': job.apiKey
          }
        });

        const result = response.data;
        console.log('Screenshot result:', result);

        // Parse the result data if it contains JSON as a string
        const parsedBody = JSON.parse(result.body);

        // Store the screenshot URL in the database
        if (parsedBody && parsedBody.screenshotUrl) {
          await saveScreenshot(job.userId, parsedBody.screenshotUrl);
          console.log('Screenshot saved:', parsedBody.screenshotUrl);
        }

        // Log the remaining screenshots
        job.numScreenshots--;  // Decrement the number of screenshots locally
        console.log('Screenshots left for job ' + job._id + ': ' + job.numScreenshots);  // Changed to regular concatenation
        await updateQueuedJob(job._id, job.numScreenshots); // Update in database

      } catch (error) {
        console.error('Error executing job:', error);
      }

      // Check if the job is complete and delete if necessary
      if (job.numScreenshots <= 0) {
        await deleteQueuedJob(job._id);
        console.log('Deleted completed job: ' + job._id);  // Changed to regular concatenation
        break;
      }

      // Wait for the specified interval before taking the next screenshot
      await new Promise(resolve => setTimeout(resolve, job.interval * 1000));
    }
  } finally {
    // Unlock the job after execution
    await QueuedScreenshot.findByIdAndUpdate(job._id, { isLocked: false });
  }
}

// Function to check for queued jobs and execute them
async function checkForQueuedJobs() {
  try {
    console.log('Checking for queued jobs...');
    const queuedJobs = await QueuedScreenshot.find({ status: 'queued', isLocked: false });
    console.log('Found queued jobs:', queuedJobs); // Log queued jobs from the database

    for (const job of queuedJobs) {
      await executeJob(job);
    }
  } catch (error) {
    console.error('Error checking queued jobs:', error);
  }
}

// Periodically check for queued jobs
setInterval(checkForQueuedJobs, 10000);

// Registration route
app.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword, confirmed: false });

    await user.save();
    console.log('User saved: ' + user.email);

    const token = user._id; // Use user ID as the token
    const mailOptions = {
      from: process.env.SMTP_USER,
      to: email,
      subject: 'Confirm your email',
      text: 'Please confirm your email by clicking the following link: http://' + req.headers.host + '/confirm/' + token
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('Error sending email:', error.message);
        return res.status(500).send('Error sending email: ' + error.message);
      }
      console.log('Email sent successfully:', info.response);
      res.send('A confirmation email has been sent to your email address. Please confirm to continue.');
    });
  } catch (err) {
    console.error('Error in registration process:', err);
    res.status(500).send('Error during registration');
  }
});

// Email confirmation route
app.get('/confirm/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const user = await User.findById(token);
    if (!user) {
      console.error('User not found');
      return res.status(400).send('Invalid token');
    }

    user.confirmed = true;

    // Call the API after confirmation
    try {
      const apiResponse = await axios.post('https://51c4rg79bg.execute-api.eu-west-3.amazonaws.com/apikeymaker');

      // Store the API response as an object
      user.apiResponse = apiResponse.data;

      await user.save();

      // Display the API response on the confirmation page
      res.send('Email confirmed successfully! Your API response is: ' + JSON.stringify(user.apiResponse) + '. You can now login.');
    } catch (apiError) {
      console.error('Error calling API:', apiError.message);
      return res.status(500).send('Error during email confirmation and API call: ' + apiError.message);
    }

  } catch (err) {
    console.error('Error in email confirmation process:', err);
    res.status(500).send('Error confirming email');
  }
});

// Login route
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  User.findOne({ email }, async (err, user) => {
    if (err || !user) {
      console.error('User not found:', err);
      return res.status(400).send('User not found');
    }
    if (!user.confirmed) {
      console.log('User email not confirmed:', user.email);
      return res.status(400).send('Please confirm your email first');
    }

    const match = await bcrypt.compare(password, user.password);
    if (match) {
      req.session.user = user;
      res.redirect('/welcome');
    } else {
      console.log('Incorrect password attempt for user:', user.email);
      res.status(400).send('Incorrect password');
    }
  });
});

// Welcome route
app.get('/welcome', async (req, res) => {
  if (!req.session.user) {
    console.log('User not logged in, redirecting to home');
    return res.redirect('/');
  }

  // Serve the welcome page with CSS and the form
  const user = await User.findById(req.session.user._id);
  if (!user) {
    console.error('User not found in session');
    return res.redirect('/');
  }

  const apiKey = user.apiResponse.apiKey;
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome</title>
        <link rel="stylesheet" href="/style.css">
        <script>
          async function sendUrl() {
            const url = document.getElementById('url-input').value;
            const numScreenshots = document.getElementById('screenshot-count').value;
            let interval = document.getElementById('time-interval').value;
            const apiKey = '${apiKey}'; // Using single quotes for concatenation

            if (!url) {
              alert("Please enter a valid URL");
              return;
            }

            // Ensure the time interval is at least 10 seconds
            if (interval < 10) {
              interval = 10;
            }

            // Disable the button and change the text to indicate waiting state
            const sendButton = document.getElementById('send-button');
            sendButton.disabled = true;
            sendButton.innerText = "Queueing screenshots...";

            // Queue the screenshot job in the database
            const jobData = {
              userId: '${user._id}',  // Using single quotes for concatenation
              url,
              apiKey,
              numScreenshots,
              interval
            };

            try {
              const response = await fetch('/queue-screenshot', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(jobData)
              });

              const result = await response.json();
              console.log('Job queued:', result);

              document.getElementById('screenshot-status').innerText = 'Job queued successfully. The server will take screenshots in the background.';
            } catch (error) {
              console.error('Error queueing screenshot job:', error);
              document.getElementById('screenshot-status').innerText = 'Error queueing screenshot job: ' + error.message;
            } finally {
              sendButton.disabled = false;
              sendButton.innerText = "Send";
            }
          }

          // Check for queued jobs periodically
          async function checkForQueuedJobs() {
            try {
              const response = await fetch('/check-queued-jobs', {
                method: 'GET'
              });

              const result = await response.json();

              if (result.length > 0) {
                console.log('Executing queued jobs...');
                for (const job of result) {
                  await executeJob(job);
                }
              } else {
                console.log('No queued jobs found.');
              }
            } catch (error) {
              console.error('Error checking for queued jobs:', error);
            }
          }

          // Check for queued jobs every 10 seconds
          setInterval(checkForQueuedJobs, 10000);

          // Update the display for the sliders
          function updateSliderValues() {
            document.getElementById('screenshot-count-display').innerText = document.getElementById('screenshot-count').value;
            document.getElementById('time-interval-display').innerText = document.getElementById('time-interval').value;
          }

          // Delete selected screenshot
          async function deleteSelectedScreenshot() {
            const selectedScreenshot = document.getElementById('previous-screenshots').value;
            if (selectedScreenshot === 'Select a screenshot') {
              alert('Please select a screenshot to delete.');
              return;
            }

            try {
              const response = await fetch('/delete-screenshot', {
                method: 'DELETE',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ url: selectedScreenshot })
              });

              const result = await response.json();
              alert(result.message);
              location.reload(); // Reload to update the screenshot list
            } catch (error) {
              console.error('Error deleting screenshot:', error);
              alert('Error deleting screenshot: ' + error.message);
            }
          }

          // Delete all screenshots
          async function deleteAllScreenshots() {
            if (!confirm('Are you sure you want to delete all screenshots? This action cannot be undone.')) {
              return;
            }

            try {
              const response = await fetch('/delete-all-screenshots', {
                method: 'DELETE',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ userId: '${user._id}' })  // Using single quotes for concatenation
              });

              const result = await response.json();
              alert(result.message);
              location.reload(); // Reload to update the screenshot list
            } catch (error) {
              console.error('Error deleting all screenshots:', error);
              alert('Error deleting all screenshots: ' + error.message);
            }
          }
        </script>
      </head>
      <body>
        <div class="container">
          <h1 style="text-align:center;">Hello, ${user.email}</h1>
          <!-- <p>API Response: ${JSON.stringify(user.apiResponse)}</p> -->

          <div class="form-container">
            <h2>Submit URL</h2>
            <input type="text" id="url-input" placeholder="Enter website URL" required style="width: 300px; padding: 10px;" />

            <label for="screenshot-count">Number of screenshots:</label>
            <input type="range" id="screenshot-count" min="1" max="10" value="1" oninput="updateSliderValues()" />
            <span id="screenshot-count-display">1</span>

            <label for="time-interval">Time interval between screenshots (seconds):</label>
            <input type="range" id="time-interval" min="10" max="60" value="10" oninput="updateSliderValues()" />
            <span id="time-interval-display">10</span>

            <button id="send-button" onclick="sendUrl()" style="padding: 10px 20px; background-color: #28a745; color: #fff; border: none; cursor: pointer;">Send</button>
            <pre id="request-body-display" style="margin-top: 20px; background-color: #f9f9f9; padding: 10px; border: 1px solid #ddd;"></pre>
          </div>

          <!-- Screenshot images will appear here -->
          <div id="screenshot-url" style="margin-top: 20px; color: green;"></div>

          <!-- Status of screenshot queue -->
          <div id="screenshot-status" style="margin-top: 20px; color: red;">No queued jobs.</div>

          <!-- Dropdown for previous screenshots -->
          <h2>Previous Screenshots</h2>
          <select id="previous-screenshots" style="width: 100%; padding: 10px;">
            <option>Select a screenshot</option>
            ${user.screenshots.map(s => `
              <option value="${s.url}">${new Date(s.takenAt).toLocaleString()}: ${s.url}</option>
            `).join('')}
          </select>
          <div id="selected-screenshot" style="margin-top: 20px;"></div>
          <button onclick="deleteSelectedScreenshot()" style="padding: 10px 20px; background-color: #dc3545; color: #fff; border: none; cursor: pointer;">Delete Selected Screenshot</button>
          <button onclick="deleteAllScreenshots()" style="padding: 10px 20px; background-color: #dc3545; color: #fff; border: none; cursor: pointer; margin-left: 10px;">Delete All Screenshots</button>

          <script>
            document.getElementById('previous-screenshots').addEventListener('change', function() {
              const url = this.value;
              if (url !== 'Select a screenshot') {
                document.getElementById('selected-screenshot').innerHTML = '<img src="' + url + '" style="width: 300px; margin-top: 20px;">';
              }
            });
          </script>

        </div>
      </body>
    </html>
  `);
});

// Route to queue a screenshot job
app.post('/queue-screenshot', async (req, res) => {
  try {
    const { userId, url, apiKey, numScreenshots, interval } = req.body;

    console.log('Received request to queue screenshot job:', req.body);

    // Save the queued job to the database
    const newJob = new QueuedScreenshot({
      userId,
      url,
      apiKey,
      numScreenshots,
      interval
    });
    await newJob.save();

    res.status(200).json({ message: 'Job queued successfully' });
  } catch (error) {
    console.error('Error queueing screenshot job:', error);
    res.status(500).json({ message: 'Error queueing screenshot job', error: error.message });
  }
});

// Route to get queued jobs for the user
app.get('/check-queued-jobs', async (req, res) => {
  try {
    const queuedJobs = await QueuedScreenshot.find({ status: 'queued', isLocked: false });
    res.status(200).json(queuedJobs);
  } catch (error) {
    console.error('Error checking queued jobs:', error);
    res.status(500).json({ message: 'Error checking queued jobs', error: error.message });
  }
});

// Route to save screenshot URL in the user's document
app.post('/save-screenshot', async (req, res) => {
  try {
    const { userId, screenshotUrl } = req.body;

    await User.findByIdAndUpdate(userId, {
      $push: {
        screenshots: { url: screenshotUrl, takenAt: new Date() }
      }
    });

    res.status(200).json({ message: 'Screenshot saved successfully' });
  } catch (error) {
    console.error('Error saving screenshot:', error);
    res.status(500).json({ message: 'Error saving screenshot', error: error.message });
  }
});

// Route to update queued job
app.patch('/update-queued-job', async (req, res) => {
  try {
    const { jobId, numScreenshots } = req.body;

    await QueuedScreenshot.findByIdAndUpdate(jobId, {
      numScreenshots
    });

    res.status(200).json({ message: 'Queued job updated successfully' });
  } catch (error) {
    console.error('Error updating queued job:', error);
    res.status(500).json({ message: 'Error updating queued job', error: error.message });
  }
});

// Route to delete queued job
app.delete('/delete-queued-job', async (req, res) => {
  try {
    const { jobId } = req.body;
    await QueuedScreenshot.findByIdAndDelete(jobId);
    res.status(200).json({ message: 'Queued job deleted successfully' });
  } catch (error) {
    console.error('Error deleting queued job:', error);
    res.status(500).json({ message: 'Error deleting queued job', error: error.message });
  }
});

// Route to delete a selected screenshot
app.delete('/delete-screenshot', async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.session.user._id;

    await User.findByIdAndUpdate(userId, {
      $pull: { screenshots: { url } }
    });

    res.status(200).json({ message: 'Screenshot deleted successfully' });
  } catch (error) {
    console.error('Error deleting screenshot:', error);
    res.status(500).json({ message: 'Error deleting screenshot', error: error.message });
  }
});

// Route to delete all screenshots
app.delete('/delete-all-screenshots', async (req, res) => {
  try {
    const { userId } = req.body;

    await User.findByIdAndUpdate(userId, {
      $set: { screenshots: [] }
    });

    res.status(200).json({ message: 'All screenshots deleted successfully' });
  } catch (error) {
    console.error('Error deleting all screenshots:', error);
    res.status(500).json({ message: 'Error deleting all screenshots', error: error.message });
  }
});

// Route to handle the POST request with URL and API key
app.post('/submit-url', async (req, res) => {
  try {
    const { url, apiKey } = req.body;

    console.log('Received URL:', url);
    console.log('API Key:', apiKey);

    // Send the request to the external API using axios
    const externalApiResponse = await axios.post('https://cqm5bqughe.execute-api.eu-west-3.amazonaws.com/free/source', {
      body: JSON.stringify({
        url,
        apiKey
      }) // Rebuild the body similar to Postman
    }, {
      headers: {
        'x-api-key': apiKey
      }
    });

    console.log('External API Response:', externalApiResponse.data);

    // Send the external API response back to the client
    res.status(200).json({ message: 'Request successful', data: externalApiResponse.data });
  } catch (error) {
    console.error('Error in submit-url:', error.message);
    res.status(500).json({ message: 'Error processing the request', error: error.message });
  }
});

// Start the server
app.listen(port, () => {
  console.log('App is running on http://localhost:' + port);
});
