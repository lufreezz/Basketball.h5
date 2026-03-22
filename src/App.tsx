import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Matter from 'matter-js';

type GameState = 'START' | 'PLAYING' | 'GAME_OVER';

const BALL_RADIUS = 45;
const HOOP_RADIUS = 6;
const HOOP_WIDTH = 120;

const CATEGORY_BALL = 0x0001;
const CATEGORY_WALL = 0x0002;
const CATEGORY_HOOP = 0x0004; // Used for rims
const CATEGORY_SENSOR = 0x0008;
const CATEGORY_BACKBOARD = 0x0010;

let audioCtx: AudioContext | null = null;

const initAudio = () => {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
};

const playShootSound = () => {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, audioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
};

const playSwishSound = () => {
    if (!audioCtx) return;
    const bufferSize = audioCtx.sampleRate * 0.3;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200;
    filter.Q.value = 0.5;
    
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.4, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
    
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);
    noise.start();
};

const playScoreSound = () => {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
    osc.frequency.setValueAtTime(1108.73, audioCtx.currentTime + 0.1); // C#6
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
};

export default function App() {
  const [gameState, setGameState] = useState<GameState>('START');
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(() => parseInt(localStorage.getItem('basketball_best') || '0'));
  const [floatingTexts, setFloatingTexts] = useState<{id: number, x: number, y: number}[]>([]);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const engineRef = useRef<Matter.Engine | null>(null);
  const runnerRef = useRef<Matter.Runner | null>(null);
  
  const ballRef = useRef<Matter.Body | null>(null);
  const hoopPartsRef = useRef<{rimL: Matter.Body, rimR: Matter.Body, sensor: Matter.Body} | null>(null);
  
  const reqRef = useRef<number>(0);
  
  const stateRef = useRef({
    gameState: 'START' as GameState,
    score: 0,
    hoopBaseX: 0,
    hoopBaseY: 0,
    hoopY: 0, // Current visual Y
    hasScored: false,
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    dragCurrent: { x: 0, y: 0 },
    dragStartTime: 0,
    ballCanShoot: true,
    isAboveHoop: false,
    isRollingBack: false,
    rollBackProgress: 0,
    rollBackStartX: 0,
    time: 0,
    netStretch: 0,
    netVelocity: 0,
    bestScore: parseInt(localStorage.getItem('basketball_best') || '0'),
    hoopPhaseX: 0,
    hoopPhaseY: 0
  });

  const setGameStateSafe = (newState: GameState) => {
      setGameState(newState);
      stateRef.current.gameState = newState;
  };

  const initPhysics = (width: number, height: number) => {
      if (engineRef.current) return;

      const engine = Matter.Engine.create({
          gravity: { x: 0, y: 1.0, scale: 0.0025 } // Adjusted gravity
      });
      engineRef.current = engine;

      // Walls & Floor
      const wallOptions = { 
          isStatic: true, 
          restitution: 0.4,
          friction: 0.5,
          collisionFilter: { category: CATEGORY_WALL, mask: CATEGORY_BALL }
      };
      
      Matter.Composite.add(engine.world, [
          Matter.Bodies.rectangle(-25, height / 2, 50, height * 2, { ...wallOptions, label: 'wallLeft' }), // Left
          Matter.Bodies.rectangle(width + 25, height / 2, 50, height * 2, { ...wallOptions, label: 'wallRight' }), // Right
      ]);

      // Ball
      const ball = Matter.Bodies.circle(width / 2, height - 150 - BALL_RADIUS, BALL_RADIUS, {
          restitution: 0.6,
          friction: 0.005,
          density: 0.005, // Lower density makes it lighter, requiring less force
          frictionAir: 0.001, // Air friction prevents infinite speed
          collisionFilter: {
              category: CATEGORY_BALL,
              mask: CATEGORY_WALL | CATEGORY_SENSOR // Starts by only hitting walls and sensor
          },
          label: 'ball'
      });
      Matter.Body.setStatic(ball, true); // Set static AFTER creation to preserve original density
      ballRef.current = ball;
      Matter.Composite.add(engine.world, ball);

      // Hoop Parts
      stateRef.current.hoopBaseX = width / 2;
      stateRef.current.hoopBaseY = height * 0.35;
      stateRef.current.hoopY = stateRef.current.hoopBaseY;

      const hoopOptions = {
          isStatic: true,
          restitution: 0.4,
          friction: 0.5,
          collisionFilter: { category: CATEGORY_HOOP, mask: CATEGORY_BALL }
      };

      const rimL = Matter.Bodies.circle(0, 0, HOOP_RADIUS, hoopOptions);
      const rimR = Matter.Bodies.circle(0, 0, HOOP_RADIUS, hoopOptions);
      
      const sensor = Matter.Bodies.rectangle(0, 0, 30, 10, {
          isStatic: true,
          isSensor: true,
          collisionFilter: { category: CATEGORY_SENSOR, mask: CATEGORY_BALL },
          label: 'sensor'
      });

      hoopPartsRef.current = { rimL, rimR, sensor };
      Matter.Composite.add(engine.world, [rimL, rimR, sensor]);

      // Collision events
      Matter.Events.on(engine, 'collisionStart', (event) => {
          const pairs = event.pairs;
          for (let i = 0; i < pairs.length; i++) {
              const { bodyA, bodyB } = pairs[i];
              const sensorBody = hoopPartsRef.current?.sensor;
              const currentBall = ballRef.current;
              
              if (sensorBody && currentBall) {
                  if ((bodyA === sensorBody && bodyB === currentBall) || (bodyB === sensorBody && bodyA === currentBall)) {
                      // Only score if falling down and horizontally within the hoop
                      if (stateRef.current.gameState === 'PLAYING' && currentBall.velocity.y > 0 && !stateRef.current.hasScored) {
                          const dx = Math.abs(currentBall.position.x - sensorBody.position.x);
                          if (dx < 40) {
                              scorePoint();
                          }
                      }
                  }
              }
          }
      });

      const runner = Matter.Runner.create();
      runnerRef.current = runner;
      Matter.Runner.run(runner, engine);
      
      reqRef.current = requestAnimationFrame(update);
  };

  const scorePoint = () => {
      stateRef.current.hasScored = true;
      
      playSwishSound();
      setTimeout(playScoreSound, 100);

      const newScore = stateRef.current.score + 1;
      stateRef.current.score = newScore;
      setScore(newScore);
      
      if (newScore > stateRef.current.bestScore) {
          stateRef.current.bestScore = newScore;
          setBestScore(newScore);
          localStorage.setItem('basketball_best', newScore.toString());
      }
      
      // Floating text
      const pos = ballRef.current?.position;
      if (pos) {
          const id = Date.now();
          setFloatingTexts(prev => [...prev, { id, x: pos.x, y: pos.y }]);
          setTimeout(() => setFloatingTexts(prev => prev.filter(ft => ft.id !== id)), 1000);
      }
  };

  const resetBall = () => {
      if (ballRef.current && containerRef.current) {
          const { width, height } = containerRef.current.getBoundingClientRect();
          Matter.Body.setStatic(ballRef.current, true);
          Matter.Body.setPosition(ballRef.current, { x: width / 2, y: height - 150 - BALL_RADIUS });
          Matter.Body.setVelocity(ballRef.current, { x: 0, y: 0 });
          Matter.Body.setAngularVelocity(ballRef.current, 0);
          stateRef.current.ballCanShoot = true;
          stateRef.current.hasScored = false;
          stateRef.current.isAboveHoop = false;
          ballRef.current.collisionFilter.mask = CATEGORY_WALL | CATEGORY_SENSOR;
      }
  };

  const startGame = () => {
      setGameStateSafe('PLAYING');
      setScore(0);
      stateRef.current.score = 0;
      stateRef.current.hasScored = false;
      stateRef.current.time = 0;
      resetBall();
  };

  const handlePointerDown = (e: React.PointerEvent) => {
      initAudio();
      
      if (stateRef.current.gameState === 'START' || stateRef.current.gameState === 'GAME_OVER') {
          startGame();
          return;
      }
      
      if (stateRef.current.gameState === 'PLAYING' && stateRef.current.ballCanShoot && !stateRef.current.isRollingBack && ballRef.current && containerRef.current) {
          if (!e || e.clientX === undefined || e.clientY === undefined) return;
          const rect = containerRef.current.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          
          // Allow swiping from anywhere on the screen
          stateRef.current.isDragging = true;
          stateRef.current.dragStart = { x, y };
          stateRef.current.dragCurrent = { x, y };
          stateRef.current.dragStartTime = Date.now();
      }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
      if (stateRef.current.isDragging && containerRef.current) {
          // Ignore invalid events where clientX/Y are missing or 0 (often happens on touch cancel/end bugs)
          if (!e || (e.clientX === 0 && e.clientY === 0) || e.clientX === undefined || e.clientY === undefined) return;
          
          const rect = containerRef.current.getBoundingClientRect();
          stateRef.current.dragCurrent = { 
              x: e.clientX - rect.left, 
              y: e.clientY - rect.top 
          };
      }
  };

  const handlePointerUp = () => {
      if (stateRef.current.isDragging && ballRef.current && stateRef.current.ballCanShoot) {
          stateRef.current.isDragging = false;
          
          // Swipe up to shoot
          let dx = stateRef.current.dragCurrent.x - stateRef.current.dragStart.x;
          let dy = stateRef.current.dragCurrent.y - stateRef.current.dragStart.y;
          
          // Require a deliberate upward swipe (at least 20 pixels) and valid numbers
          if (dy < -20 && !isNaN(dx) && !isNaN(dy)) {
              // Clamp the drag distance to prevent insane speeds
              // Max horizontal drag = 150px, Max vertical drag = 200px
              const clampedDx = Math.max(-150, Math.min(150, dx));
              const clampedDy = Math.max(-200, Math.min(-20, dy));
              
              // Calculate distance to hoop
              const ballPos = ballRef.current.position;
              const hoopY = stateRef.current.hoopY;
              const distanceY = Math.max(200, ballPos.y - hoopY); // Positive value, e.g. 400
              
              // Base multiplier on distance to ensure the ball can reach the hoop
              const distanceRatio = Math.sqrt(distanceY / 400);
              const swipeRatioY = Math.sqrt(Math.abs(clampedDy) / 100);
              
              // Map distance to velocity. 
              const vy = -23 * swipeRatioY * distanceRatio; 
              const vx = clampedDx * 0.08 * distanceRatio;
              
              Matter.Body.setStatic(ballRef.current, false);
              Matter.Sleeping.set(ballRef.current, false);
              
              // Apply velocity
              Matter.Body.setVelocity(ballRef.current, { x: vx, y: vy });
              Matter.Body.setAngularVelocity(ballRef.current, vx * 0.02);
              stateRef.current.ballCanShoot = false;
              
              playShootSound();
          }
      }
  };

  const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx || !containerRef.current) return;

      const { width, height } = canvas;
      const { hoopY, netStretch } = stateRef.current;
      const hoopX = hoopPartsRef.current?.rimL.position.x ? hoopPartsRef.current.rimL.position.x + HOOP_WIDTH/2 : width/2;
      const startY = height - 150;

      ctx.clearRect(0, 0, width, height);

      // Background (Wall)
      ctx.fillStyle = '#90C8C6';
      ctx.fillRect(0, 0, width, height);

      // 3D Floor (Trapezoid)
      const horizonY = stateRef.current.hoopBaseY + 160; // The line where wall meets floor
      
      ctx.beginPath();
      ctx.moveTo(width / 2 - 120, horizonY); // Top left
      ctx.lineTo(width / 2 + 120, horizonY); // Top right
      ctx.lineTo(width / 2 + 300, height); // Bottom right
      ctx.lineTo(width / 2 - 300, height); // Bottom left
      ctx.closePath();
      
      ctx.fillStyle = '#367484'; // Floor inner color
      ctx.fill();
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#C36B35'; // Floor border color
      ctx.stroke();

      const bbWidth = 240;
      const bbHeight = 160;
      const bbX = hoopX - bbWidth/2;
      const bbY = hoopY - 150;

      // Draw Backboard Outer
      ctx.fillStyle = '#C36B35';
      ctx.fillRect(bbX, bbY, bbWidth, bbHeight);
      
      // Draw Backboard Inner
      ctx.fillStyle = '#367484';
      ctx.fillRect(bbX + 8, bbY + 8, bbWidth - 16, bbHeight - 16);
      
      // Backboard Inner Shadow/Highlight (Two-tone effect)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.beginPath();
      ctx.moveTo(bbX + bbWidth/2, bbY + 8);
      ctx.lineTo(bbX + bbWidth - 8, bbY + 8);
      ctx.lineTo(bbX + bbWidth - 8, bbY + bbHeight - 8);
      ctx.lineTo(bbX + bbWidth/2, bbY + bbHeight - 8);
      ctx.fill();

      // Inner Yellow Square
      const sqWidth = 80;
      const sqHeight = 60;
      ctx.strokeStyle = '#F4D04E';
      ctx.lineWidth = 8;
      ctx.lineJoin = 'round';
      ctx.strokeRect(hoopX - sqWidth/2, hoopY - sqHeight - 5, sqWidth, sqHeight);

      // Back Rim (Top half of ellipse)
      ctx.strokeStyle = '#F26A36';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.ellipse(hoopX, hoopY, HOOP_WIDTH/2, 12, 0, Math.PI, Math.PI * 2);
      ctx.stroke();

      // Helper to draw the ball
      const drawBall = () => {
          if (!ballRef.current) return;
          const pos = ballRef.current.position;
          const angle = ballRef.current.angle;

          let scale = 1.0;

          ctx.save();
          ctx.translate(pos.x, pos.y);
          ctx.rotate(angle);
          ctx.scale(scale, scale);

          // Ball Base
          ctx.fillStyle = '#E5733B';
          ctx.beginPath();
          ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
          ctx.fill();
          
          // Ball Highlight (Top Left)
          ctx.fillStyle = '#F09A61';
          ctx.beginPath();
          ctx.arc(-BALL_RADIUS*0.3, -BALL_RADIUS*0.3, BALL_RADIUS*0.6, 0, Math.PI * 2);
          ctx.fill();

          // Ball Lines
          ctx.strokeStyle = '#C35325';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(0, -BALL_RADIUS);
          ctx.lineTo(0, BALL_RADIUS);
          ctx.moveTo(-BALL_RADIUS, 0);
          ctx.lineTo(BALL_RADIUS, 0);
          ctx.stroke();

          ctx.beginPath();
          ctx.ellipse(0, 0, BALL_RADIUS * 0.6, BALL_RADIUS, 0, 0, Math.PI * 2);
          ctx.stroke();

          ctx.restore();
      };

      // Determine drawing order based on Z-depth (scale) and position
      let drawBallBehindFrontRim = false;
      if (ballRef.current) {
          const pos = ballRef.current.position;
          // If the ball is falling and is near the hoop opening, it's inside/behind the front rim
          if (stateRef.current.isAboveHoop && pos.y < hoopY + 20) {
              drawBallBehindFrontRim = true;
          } else if (pos.y >= hoopY + 20 && pos.y < hoopY + 100 && ballRef.current.velocity.y > 0) {
              // If the ball is falling through the net, it should be behind the front rim
              // but in front of the backboard (handled by drawing order)
              // We only want it behind the front rim if it actually went IN the hoop
              // We can check if it's between the left and right rims
              if (pos.x > hoopX - HOOP_WIDTH/2 && pos.x < hoopX + HOOP_WIDTH/2) {
                  drawBallBehindFrontRim = true;
              }
          }
      }

      // Draw Ball IF it is behind the front rim
      if (drawBallBehindFrontRim) {
          drawBall();
      }

      // Front Rim (Bottom half of ellipse)
      ctx.strokeStyle = '#F26A36';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.ellipse(hoopX, hoopY, HOOP_WIDTH/2, 12, 0, 0, Math.PI);
      ctx.stroke();

      // Net
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      
      const netTopL = hoopX - HOOP_WIDTH/2 + 2;
      const netTopR = hoopX + HOOP_WIDTH/2 - 2;
      
      const stretchRatio = Math.min(1, Math.max(0, netStretch / 80));
      const netBottomWidth = (HOOP_WIDTH - 24) * (1 - stretchRatio * 0.4);
      const netBottomL = hoopX - netBottomWidth/2;
      const netBottomR = hoopX + netBottomWidth/2;
      const netBottomY = hoopY + 45 + netStretch;

      // Draw outer curves (rope-like)
      ctx.moveTo(netTopL, hoopY);
      ctx.quadraticCurveTo(hoopX - HOOP_WIDTH/2 + 10 - stretchRatio * 15, hoopY + 20 + netStretch/2, netBottomL, netBottomY);
      ctx.lineTo(netBottomR, netBottomY);
      ctx.quadraticCurveTo(hoopX + HOOP_WIDTH/2 - 10 + stretchRatio * 15, hoopY + 20 + netStretch/2, netTopR, hoopY);
      
      // Net cross lines
      for (let i = 1; i < 4; i++) {
          const t = i / 4;
          const yOffset = (45 + netStretch) * t;
          const widthAtY = (HOOP_WIDTH - 4) - ((HOOP_WIDTH - 4) - netBottomWidth) * t;
          ctx.moveTo(hoopX - widthAtY/2, hoopY + yOffset);
          ctx.lineTo(hoopX + widthAtY/2, hoopY + yOffset);
      }
      for (let i = 1; i < 5; i++) {
          const xOffsetTop = (HOOP_WIDTH - 4) * (i / 5);
          const xOffsetBottom = netBottomWidth * (i / 5);
          const startX = netTopL + xOffsetTop;
          const endX = netBottomL + xOffsetBottom;
          const midX = startX + (endX - startX) / 2;
          const midY = hoopY + (45 + netStretch) / 2;
          ctx.moveTo(startX, hoopY);
          ctx.quadraticCurveTo(midX, midY, endX, netBottomY);
      }
      ctx.stroke();

      // Draw Ball IF it is in front of the front rim
      if (!drawBallBehindFrontRim) {
          drawBall();
      }
  };

  const update = () => {
      if (stateRef.current.gameState === 'PLAYING' && containerRef.current && ballRef.current && hoopPartsRef.current) {
          const { width, height } = containerRef.current.getBoundingClientRect();
          const ball = ballRef.current;
          const parts = hoopPartsRef.current;
          
          // 1. Update Hoop Position based on score
          let speedX = 0;
          let speedY = 0;
          if (stateRef.current.score >= 10) {
              speedX = Math.min(1 + (stateRef.current.score - 10) * 0.15, 3.5);
          }
          if (stateRef.current.score >= 20) {
              speedY = Math.min(0.8 + (stateRef.current.score - 20) * 0.1, 2.5);
          }

          stateRef.current.hoopPhaseX += speedX * 0.016;
          stateRef.current.hoopPhaseY += speedY * 0.016;

          let targetX = stateRef.current.hoopBaseX;
          let targetY = stateRef.current.hoopBaseY;

          if (speedX > 0) {
              targetX += Math.sin(stateRef.current.hoopPhaseX) * (width * 0.25);
          }
          if (speedY > 0) {
              targetY += Math.sin(stateRef.current.hoopPhaseY) * (height * 0.1);
          }

          stateRef.current.hoopY = targetY;
          Matter.Body.setPosition(parts.rimL, { x: targetX - HOOP_WIDTH/2, y: targetY });
          Matter.Body.setPosition(parts.rimR, { x: targetX + HOOP_WIDTH/2, y: targetY });
          Matter.Body.setPosition(parts.sensor, { x: targetX, y: targetY + 40 });

          // 2. 3D Depth Illusion (Hysteresis Collision)
          let mask = CATEGORY_WALL | CATEGORY_SENSOR;
          let isAbove = false;

          if (ball.position.y < targetY + 10) {
              // Ball is physically above the rim. Collide so it can bounce.
              mask |= CATEGORY_HOOP;
              isAbove = true;
          } else if (ball.velocity.y > 0 && ball.position.y < targetY + 40) {
              // Ball is falling and just reached the rim level.
              mask |= CATEGORY_HOOP;
              isAbove = true;
          } else {
              // Ball is below the rim and going up, or far below.
              isAbove = false;
          }

          ball.collisionFilter.mask = mask;
          stateRef.current.isAboveHoop = isAbove;

          // 3. Net Animation Physics
          let targetStretch = 0;
          // Only trigger net stretch if the ENTIRE ball has passed the rim (y - radius > targetY)
          if (ball.velocity.y > 0 && (ball.position.y - BALL_RADIUS) > targetY && ball.position.y < targetY + 150 && 
              Math.abs(ball.position.x - targetX) < HOOP_WIDTH / 2) {
              // Ball is falling inside the net
              targetStretch = (ball.position.y - targetY) * 0.8; 
          } else if (stateRef.current.hasScored && ball.position.y >= targetY + 100 && ball.position.y < targetY + 200) {
              // Ball just passed through, give it a final tug
              targetStretch = 40;
          }

          const stretchForce = (targetStretch - stateRef.current.netStretch) * 0.2; // Softer spring for rope feel
          stateRef.current.netVelocity += stretchForce;
          stateRef.current.netStretch += stateRef.current.netVelocity;
          stateRef.current.netVelocity *= 0.85; // Damping

          // 4. Check Game Over / Reset / Rollback
          if (!stateRef.current.isRollingBack && (ball.position.y > height + BALL_RADIUS || ball.position.x < -50 || ball.position.x > width + 50)) {
              if (!stateRef.current.hasScored) {
                  setScore(0);
                  stateRef.current.score = 0;
              }
              
              stateRef.current.isRollingBack = true;
              stateRef.current.rollBackProgress = 0;
              stateRef.current.rollBackStartX = Math.max(BALL_RADIUS, Math.min(width - BALL_RADIUS, ball.position.x));
              
              Matter.Body.setStatic(ball, true);
              Matter.Body.setPosition(ball, { x: stateRef.current.rollBackStartX, y: height + BALL_RADIUS });
          }

          if (stateRef.current.isRollingBack) {
              stateRef.current.rollBackProgress += 0.04; // Adjust speed of rollback
              const p = Math.min(1, stateRef.current.rollBackProgress);
              const easeOut = 1 - Math.pow(1 - p, 3); // Cubic ease out
              
              const startX = stateRef.current.rollBackStartX;
              const rollStartY = height + BALL_RADIUS;
              const endX = width / 2;
              const endY = height - 150 - BALL_RADIUS; // Starting Y position
              
              Matter.Body.setPosition(ball, {
                  x: startX + (endX - startX) * easeOut,
                  y: rollStartY + (endY - rollStartY) * easeOut
              });
              
              // Spin the ball as it rolls back
              Matter.Body.setAngle(ball, ball.angle - 0.15);
              
              if (p >= 1) {
                  stateRef.current.isRollingBack = false;
                  resetBall();
              }
          }
      }

      draw();
      reqRef.current = requestAnimationFrame(update);
  };

  useEffect(() => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;

      const resize = () => {
          const { width, height } = container.getBoundingClientRect();
          if (width === 0 || height === 0) return; // Wait for valid dimensions

          canvas.width = width;
          canvas.height = height;
          
          if (!engineRef.current) {
              initPhysics(width, height);
          } else {
              // Update positions on resize
              stateRef.current.hoopBaseX = width / 2;
              stateRef.current.hoopBaseY = height * 0.35;
              if (stateRef.current.gameState !== 'PLAYING') {
                  stateRef.current.hoopY = stateRef.current.hoopBaseY;
                  if (hoopPartsRef.current) {
                      const parts = hoopPartsRef.current;
                      const targetX = stateRef.current.hoopBaseX;
                      const targetY = stateRef.current.hoopBaseY;
                      Matter.Body.setPosition(parts.rimL, { x: targetX - HOOP_WIDTH/2, y: targetY });
                      Matter.Body.setPosition(parts.rimR, { x: targetX + HOOP_WIDTH/2, y: targetY });
                      Matter.Body.setPosition(parts.sensor, { x: targetX, y: targetY + 40 });
                  }
              }
              
              if (stateRef.current.ballCanShoot && ballRef.current) {
                  Matter.Body.setPosition(ballRef.current, { x: width / 2, y: height - 150 - BALL_RADIUS });
              }
              
              const bodies = Matter.Composite.allBodies(engineRef.current.world);
              bodies.forEach(body => {
                  if (body.label === 'wallLeft') {
                      Matter.Body.setPosition(body, { x: -25, y: height / 2 });
                  } else if (body.label === 'wallRight') {
                      Matter.Body.setPosition(body, { x: width + 25, y: height / 2 });
                  }
              });
          }
      };

      resize();
      
      const resizeObserver = new ResizeObserver(() => {
          resize();
      });
      resizeObserver.observe(container);

      return () => {
          resizeObserver.disconnect();
          cancelAnimationFrame(reqRef.current);
          if (runnerRef.current) {
              Matter.Runner.stop(runnerRef.current);
              runnerRef.current = null;
          }
          if (engineRef.current) {
              Matter.World.clear(engineRef.current.world, false);
              Matter.Engine.clear(engineRef.current);
              engineRef.current = null;
          }
      };
  }, []);

  // Trajectory removed for swipe mechanic

  return (
    <div className="relative w-full h-screen bg-[#111] flex justify-center overflow-hidden touch-none select-none">
      <div 
        ref={containerRef}
        className="relative w-full max-w-md h-full bg-[#9ED1D1] cursor-pointer shadow-2xl touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* Top UI */}
        <div className="absolute top-6 left-6 z-20 flex flex-col">
            <div className="flex items-center gap-2">
                <span className="text-white text-3xl font-black drop-shadow-md">👑</span>
                <span className="text-white text-3xl font-black drop-shadow-md">{bestScore}</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
                <span className="text-white text-3xl font-black drop-shadow-md">🏀</span>
                <span className="text-white text-3xl font-black drop-shadow-md">{score}</span>
            </div>
        </div>

        <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-0" />

        <AnimatePresence>
            {floatingTexts.map(ft => (
                <motion.div
                    key={ft.id}
                    initial={{ opacity: 0, y: ft.y, x: ft.x, scale: 0.5 }}
                    animate={{ opacity: 1, y: ft.y - 120, scale: 1.5 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 1, ease: "easeOut" }}
                    className="absolute font-black text-6xl z-40 pointer-events-none"
                    style={{ 
                        left: 0, 
                        top: 0, 
                        marginLeft: '-2rem',
                        color: '#FFD700',
                        WebkitTextStroke: '2px #C35325',
                        textShadow: '0px 4px 10px rgba(0,0,0,0.5)'
                    }}
                >
                    +1
                </motion.div>
            ))}
        </AnimatePresence>

        {/* Overlays */}
        <AnimatePresence>
           {gameState === 'START' && (
               <motion.div 
                   initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                   className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/20 backdrop-blur-sm pointer-events-none"
               >
                  <div className="text-white text-4xl font-black mb-4 tracking-widest drop-shadow-lg text-center">
                      TAP TO<br/>START
                  </div>
                  <div className="text-white/90 text-xl font-bold mb-8 tracking-widest drop-shadow-lg text-center">
                      SWIPE UP TO SHOOT
                  </div>
                  <div className="w-16 h-24 border-4 border-white rounded-full flex justify-center p-2 opacity-80">
                      <motion.div 
                          animate={{ y: [40, 0, 40] }} 
                          transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut" }}
                          className="w-4 h-4 bg-white rounded-full"
                      />
                  </div>
               </motion.div>
           )}
           {gameState === 'GAME_OVER' && (
               <motion.div 
                   initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                   className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#3A6B74]/90 backdrop-blur-md pointer-events-none"
               >
                  <div className="text-white text-6xl font-black mb-2 drop-shadow-lg">MISSED!</div>
                  <div className="text-[#EED663] text-3xl font-bold mb-12 drop-shadow-md">SCORE: {score}</div>
                  <div className="bg-[#C85A28] text-white px-10 py-4 rounded-xl font-black text-2xl shadow-[0_6px_0_#9c431b] animate-bounce">
                     TAP TO RESTART
                  </div>
               </motion.div>
           )}
        </AnimatePresence>
      </div>
    </div>
  );
}
