import 'dotenv/config';
import slackbolt from '@slack/bolt';
const { App } = slackbolt;
import { createReadStream, unlinkSync } from 'fs';

import { init } from 'raspi';
import { DigitalOutput, LOW, HIGH } from 'raspi-gpio';

import { runCodeInner } from "../src/runCodeInner.js";
import { makeIncluded } from "../src/makeIncluded.js";
import { SerialPort, SerialPortMock } from 'serialport';

import { createNodeSerialBuffer } from "../src/haxidraw/createNodeSerialBuffer.js";
import { runMachineHelper } from "../src/runMachineHelper.js";
import { createHaxidraw } from "../src/haxidraw/createHaxidraw.js";

let running = false;

const app = new App({
  token:          process.env.SLACK_BOT_TOKEN,
  signingSecret:  process.env.SLACK_SIGNING_SECRET,
  appToken:       process.env.SLACK_APP_TOKEN,
  socketMode:     true,
  port:           process.env.PORT
});

// console.log(await SerialPort.list())

const config = {
  MOCK_SERIAL:  false, // set false to test without a Blot connected
  BAUD:         9600,
  BOARD_PIN:    'GPIO4', // GPIO 4 on RPi,
  CLAMP_MAX:    120,
  CLAMP_MIN:    0
}

let port;
const path = process.env.SERIAL_PATH;
if (config.MOCK_SERIAL) { // simulates open serial port (no response back)
  SerialPortMock.binding.createPort(path);
  port = new SerialPortMock({
    path,
    baudRate: config.BAUD,
    autoOpen: false,
    endOnClose: true
  });
}
else {
  port = new SerialPort({
    path,
    baudRate: config.BAUD,
    autoOpen: false,
    endOnClose: true
  });
}

const comsBuffer = await createNodeSerialBuffer(port);
const haxidraw = await createHaxidraw(comsBuffer);

// draw path to move the Blot head back to origin
const resetTurtles = await runSync(`
  drawLines([
    [
      [0, 0]
    ]
  ])
`)

// controls the USB webcam using Motion library on the RPi
const webCam = {
  baseUrl: process.env.MOTION_URL,
  filePath: process.env.MOTION_FILEPATH,
  command(str) {
    console.log(this.baseUrl + str);
    return fetch(this.baseUrl + str);
  },
  start() {
    return this.command('/detection/connection');
  },
  // sets the filename to the current datetime and start recording using Motion
  async startEvent() {
    const datetime = new Date().toISOString()
    this.command('/config/set?movie_filename=' + datetime)
    this.command('/config/set?snapshot_filename=' + datetime)
    await this.command('/action/eventstart');
    return datetime;
  },
  // stop recording and take a snapshot using Motion
  async endEvent() { 
    this.command('/action/snapshot');
    await this.command('/action/eventend');
  }
};

async function runSync(code) {
  const { globalScope, turtles, log, docDimensions } = makeIncluded();
  await runCodeInner(code, globalScope, "../dist");
  return turtles;
}

async function fetchSlackFile(fileUrl) {
  const response = await fetch(fileUrl, {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  });
  const body = await response.text();
  return body;
}

const sendSlackFile = async (channelId, filePath, name='', comment = '') => {
  try {
    await app.client.files.uploadV2({
      channel_id:       channelId,
      initial_comment:  comment,
      file:             createReadStream(filePath),
      filename:         name
    });
  }
  catch (e) {
    console.log(e.message);
  }
  finally {
    unlinkSync(filePath);
  }
}

const scale = (value, low1, high1, low2, high2) => (
  low2 + (high2 - low2) * (value - low1) / (high1 - low1)
)

const scaleTurtles = (turtles) => {
  let max = config.CLAMP_MAX;
  let min = config.CLAMP_MIN;

  turtles.forEach(turtle => {
    turtle.path.forEach(points => {
      points.forEach( point => {
        point.forEach( val => {
          if (val > max) {
            max = val;
          }
          if (val < min) {
            min = val;
          }
        })
      })
    });
  });

  
  if (max != config.CLAMP_MAX || min != config.CLAMP_MIN) {
    turtles.forEach(turtle => {
      turtle.path = turtle.path.map(points => (
        points.map(point => point.map( val => scale(val, min, max, config.CLAMP_MIN, config.CLAMP_MAX)))
      ))
    })
  }

  return turtles;
}

const runMachine = (turtles) => {
  return runMachineHelper(haxidraw, scaleTurtles(turtles));
}

function clearBoard() {
  init(async () => {
    const output = new DigitalOutput(config.BOARD_PIN);
    output.write(HIGH);
    await sleep(0.2);
    output.write(LOW);
  });
}

// set the Blot head back to origin and clear the LCD Writing Tablet and
async function resetMachine() {
  await runMachine(resetTurtles);
  clearBoard();
}

const sleep = (s) => (
  new Promise((resolve) => {
    setTimeout(resolve, s*1000);
  })
);

async function onMessage(message, say) {
  if (!message.files) return;

  const fileUrl = message.files[0].url_private; // get the uploaded .js filename
  const code = await fetchSlackFile(fileUrl); // get the uploaded .js file through Slack

  const turtles = await runSync(code); // try to run the blot code and generate path

  const datetime = await webCam.startEvent();
  const filename = webCam.filePath + '/' + datetime;

  say("I'm drawing your code at teleblot.hackclub.com, I'll send you a clip when its done!");

  clearBoard();

  await runMachine(turtles); // send drawing path to the Blot over serial

  await sleep(5);
  await webCam.endEvent(); // creates recording and snapshot files
  // await sleep(10);

  // sends recording and snapshot via Slack
  await sendSlackFile(message.channel, filename + '.mkv', datetime + '.mkv');
  await sendSlackFile(message.channel, filename + '.jpg', datetime + '.jpg');
}

(async () => {
  await app.stop()
  await app.start();
  await webCam.start();
  await webCam.endEvent();

  await resetMachine();

  console.log('Server running');
})();

// when user sends a file in slack and the Blot is not currently drawing, then run the code
app.message(async ({ message, say }) => {
  try {
    if (running) {
      say("Sorry I could not run your code because I'm currently drawing at teleblot.hackclub.com, please try again later.");
      return;
    }
    running = true;
    await onMessage(message, say);
  }
  catch (error) {
    console.log(error.message);
    say('Sorry I could not run your code: "' + error.message + '"'); // sends error message in Slack
  }
  running = false;
})

process.on('uncaughtException', function (err) {       
  console.log(err);
  process.exit(1);
});

process.on('exit', () => {
  console.log("stopping server...")
  port.close();
  webCam.endEvent();
});
