import circleBody from '../assets/mascots/circle-body.webp';
import circleFace from '../assets/mascots/circle-face.webp';
import circleEyes from '../assets/mascots/circle-eyes.webp';
import circleNose from '../assets/mascots/circle-nose.webp';
import squareBody from '../assets/mascots/square-body.webp';
import squareFace from '../assets/mascots/square-face.webp';
import squareEyes from '../assets/mascots/square-eyes.webp';
import squareNose from '../assets/mascots/square-nose.webp';
import polygonBody from '../assets/mascots/polygon-body.webp';
import polygonFace from '../assets/mascots/polygon-face.webp';
import polygonEyes from '../assets/mascots/polygon-eyes.webp';
import polygonNose from '../assets/mascots/polygon-nose.webp';
import eggBody from '../assets/mascots/egg-body.webp';
import eggFace from '../assets/mascots/egg-face.webp';
import eggEyes from '../assets/mascots/egg-eyes.webp';
import eggNose from '../assets/mascots/egg-nose.webp';
import bulbBody from '../assets/mascots/bulb-body.webp';
import bulbFace from '../assets/mascots/bulb-face.webp';
import bulbEyes from '../assets/mascots/bulb-eyes.webp';
import bulbNose from '../assets/mascots/bulb-nose.webp';
import cloudBody from '../assets/mascots/cloud-body.webp';
import cloudFace from '../assets/mascots/cloud-face.webp';
import cloudEyes from '../assets/mascots/cloud-eyes.webp';
import cloudNose from '../assets/mascots/cloud-nose.webp';
import shieldBody from '../assets/mascots/shield-body.webp';
import shieldFace from '../assets/mascots/shield-face.webp';
import shieldEyes from '../assets/mascots/shield-eyes.webp';
import shieldNose from '../assets/mascots/shield-nose.webp';
import splatBody from '../assets/mascots/splat-body.webp';
import splatFace from '../assets/mascots/splat-face.webp';
import splatEyes from '../assets/mascots/splat-eyes.webp';
import splatNose from '../assets/mascots/splat-nose.webp';

function assetUrl(asset: string | { src: string }): string {
  return typeof asset === 'string' ? asset : asset.src;
}

export const CLAY_ASSETS = [
  {
    body: assetUrl(circleBody),
    face: assetUrl(circleFace),
    eyes: assetUrl(circleEyes),
    nose: assetUrl(circleNose),
  },
  {
    body: assetUrl(squareBody),
    face: assetUrl(squareFace),
    eyes: assetUrl(squareEyes),
    nose: assetUrl(squareNose),
  },
  {
    body: assetUrl(polygonBody),
    face: assetUrl(polygonFace),
    eyes: assetUrl(polygonEyes),
    nose: assetUrl(polygonNose),
  },
  {
    body: assetUrl(eggBody),
    face: assetUrl(eggFace),
    eyes: assetUrl(eggEyes),
    nose: assetUrl(eggNose),
  },
  {
    body: assetUrl(bulbBody),
    face: assetUrl(bulbFace),
    eyes: assetUrl(bulbEyes),
    nose: assetUrl(bulbNose),
  },
  {
    body: assetUrl(cloudBody),
    face: assetUrl(cloudFace),
    eyes: assetUrl(cloudEyes),
    nose: assetUrl(cloudNose),
  },
  {
    body: assetUrl(shieldBody),
    face: assetUrl(shieldFace),
    eyes: assetUrl(shieldEyes),
    nose: assetUrl(shieldNose),
  },
  {
    body: assetUrl(splatBody),
    face: assetUrl(splatFace),
    eyes: assetUrl(splatEyes),
    nose: assetUrl(splatNose),
  },
] as const;
