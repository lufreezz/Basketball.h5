import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Matter from 'matter-js';

type GameState = 'START' | 'PLAYING' | 'GAME_OVER';

const BALL_RADIUS = 45;
const HOOP_RADIUS = 6;
const HOOP_WIDTH = 90;

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
    osc.type = 'square';
    osc.frequency.setValueAtTime(400, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, audioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
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
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    filter.Q.value = 1;
    
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
    
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);
    noise.start();
};

const playScoreSound = () => {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
    osc.frequency.setValueAtTime(1108.73, audioCtx.currentTime + 0.1); // C#6
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
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
  const [totalGoals, setTotalGoals] = useState(() => parseInt(localStorage.getItem('basketball_total') || '0'));
  const [floatingTexts, setFloatingTexts] = useState<{id: number, x: number, y: number}[]>([]);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const engineRef = useRef<Matter.Engine | null>(null);
  const runnerRef = useRef<Matter.Runner | null>(null);
  
  const ballRef = useRef<Matter.Body | null>(null);
  const hoopPartsRef = useRef<{rimL: Matter.Body, rimR: Matter.Body, rimBlocker?: Matter.Body} | null>(null);
  
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
    hoopPhaseY: 0,
    hoopAmpX: 0,
    hoopAmpY: 0,
    netSway: 0,
    netSwayVelocity: 0,
    netBulge: 0,
    netBulgeVelocity: 0,
    ballTrail: [] as {x: number, y: number, scale: number}[],
    ballScale: 1.0,
    highestY: 0
  });

  const setGameStateSafe = (newState: GameState) => {
      setGameState(newState);
      stateRef.current.gameState = newState;
  };

  const initPhysics = (width: number, height: number) => {
      if (engineRef.current) return;

      const engine = Matter.Engine.create({
          gravity: { x: 0, y: 1.0, scale: 0.0025 }, // Adjusted gravity
          positionIterations: 8,
          velocityIterations: 8
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
      const ball = Matter.Bodies.circle(width / 2, height - 110 - BALL_RADIUS, BALL_RADIUS, {
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
      const rimBlocker = Matter.Bodies.rectangle(0, 0, HOOP_WIDTH, 10, {
          isStatic: true,
          restitution: 0.4,
          friction: 0.5,
          collisionFilter: { category: CATEGORY_HOOP, mask: 0 } // Initially off
      });
      
      hoopPartsRef.current = { rimL, rimR, rimBlocker };
      Matter.Composite.add(engine.world, [rimL, rimR, rimBlocker]);

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
      
      const newTotal = (parseInt(localStorage.getItem('basketball_total') || '0')) + 1;
      localStorage.setItem('basketball_total', newTotal.toString());
      setTotalGoals(newTotal);
      
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
          const factor = 1.0 / stateRef.current.ballScale;
          Matter.Body.scale(ballRef.current, factor, factor);
          Matter.Body.setPosition(ballRef.current, { x: width / 2, y: height - 110 - BALL_RADIUS });
          Matter.Body.setVelocity(ballRef.current, { x: 0, y: 0 });
          Matter.Body.setAngularVelocity(ballRef.current, 0);
          stateRef.current.ballCanShoot = true;
          stateRef.current.hasScored = false;
          stateRef.current.isAboveHoop = false;
          stateRef.current.ballScale = 1.0;
          stateRef.current.highestY = height;
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
              
              // Calculate distance to hoop using BASE Y for consistent force mapping
              const ballPos = ballRef.current.position;
              const hoopBaseY = stateRef.current.hoopBaseY;
              const distanceY = Math.max(200, ballPos.y - hoopBaseY); // Positive value, e.g. 400
              
              // Base multiplier on distance to ensure the ball can reach the hoop
              const distanceRatio = Math.sqrt(distanceY / 400);
              const swipeRatioY = Math.sqrt(Math.abs(clampedDy) / 100);
              
              // Map distance to velocity. Force a minimum upward velocity for a nice parabola.
              let vy = -26 * swipeRatioY * distanceRatio; 
              if (vy < -32) vy = -32; // Cap maximum height (just above backboard)
              if (vy > -22) vy = -22; // Minimum height to reach hoop
              
              // Aim Assist: Predict future hoop position
              const { width } = containerRef.current.getBoundingClientRect();
              const timeToHoop = Math.abs(distanceY / vy) * 1.8; // Rough estimate of steps to reach hoop height
              
              // Pure swipe mechanics for authentic angle and bank shots
              // Use the ratio of horizontal swipe to vertical swipe to determine horizontal velocity
              let vx = (clampedDx / Math.abs(clampedDy)) * Math.abs(vy);
              
              // Dampen the horizontal speed slightly for better playability
              vx = vx * 0.8;
              
              // Cap maximum horizontal speed to prevent ball from flying out of bounds too fast
              if (vx > 18) vx = 18;
              if (vx < -18) vx = -18;
              
              Matter.Body.setStatic(ballRef.current, false);
              Matter.Sleeping.set(ballRef.current, false);
              
              // Apply velocity
              Matter.Body.setVelocity(ballRef.current, { x: vx, y: vy });
              Matter.Body.setAngularVelocity(ballRef.current, vx * 0.005 - 0.15); // Add backspin
              stateRef.current.ballCanShoot = false;
              stateRef.current.highestY = ballRef.current.position.y;
              
              playShootSound();
          }
      }
  };

  const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx || !containerRef.current) return;

      const { width, height } = containerRef.current.getBoundingClientRect();
      const { hoopY, netStretch } = stateRef.current;
      const hoopX = hoopPartsRef.current?.rimL?.position?.x ? hoopPartsRef.current.rimL.position.x + HOOP_WIDTH/2 : width/2;
      const startY = height - 150;

      ctx.save();
      ctx.clearRect(0, 0, width, height);

      // 1. Background (High School Gym - Slam Dunk Style)
      // Wall
      ctx.fillStyle = '#E8ECEF';
      ctx.fillRect(0, 0, width, height);
      
      // Wall Panels / Bleachers
      ctx.fillStyle = '#CFD8DC';
      ctx.fillRect(0, height * 0.4, width, height * 0.2);
      ctx.strokeStyle = '#B0BEC5';
      ctx.lineWidth = 2;
      for (let i = 0; i < width; i += 40) {
          ctx.beginPath(); ctx.moveTo(i, height * 0.4); ctx.lineTo(i, height * 0.6); ctx.stroke();
      }

      // Large Gym Windows
      ctx.fillStyle = '#81D4FA'; // Sky blue outside
      ctx.fillRect(width * 0.1, height * 0.1, width * 0.3, height * 0.25);
      ctx.fillRect(width * 0.6, height * 0.1, width * 0.3, height * 0.25);
      
      // Window Frames
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 6;
      ctx.strokeRect(width * 0.1, height * 0.1, width * 0.3, height * 0.25);
      ctx.strokeRect(width * 0.6, height * 0.1, width * 0.3, height * 0.25);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(width * 0.25, height * 0.1); ctx.lineTo(width * 0.25, height * 0.35);
      ctx.moveTo(width * 0.1, height * 0.225); ctx.lineTo(width * 0.4, height * 0.225);
      ctx.moveTo(width * 0.75, height * 0.1); ctx.lineTo(width * 0.75, height * 0.35);
      ctx.moveTo(width * 0.6, height * 0.225); ctx.lineTo(width * 0.9, height * 0.225);
      ctx.stroke();

      // Sunbeams
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.moveTo(width * 0.1, height * 0.1);
      ctx.lineTo(width * 0.4, height * 0.1);
      ctx.lineTo(width * 0.6, height);
      ctx.lineTo(0, height);
      ctx.fill();

      // 2. Floor - Polished Maple Wood Court
      const floorY = height - 150;
      
      // Floor Base
      ctx.fillStyle = '#D79E5C';
      ctx.fillRect(0, floorY, width, height - floorY);
      
      // Wood Planks (Perspective)
      ctx.strokeStyle = '#C68A47';
      ctx.lineWidth = 1;
      const vanishX = width / 2;
      for(let i=-20; i<=20; i++) {
          const startX = vanishX + i * 40;
          ctx.beginPath(); 
          ctx.moveTo(vanishX + i*10, floorY); 
          ctx.lineTo(startX, height); 
          ctx.stroke();
      }
      
      // Court Lines (White & Red)
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(0, floorY + 60);
      ctx.lineTo(width * 0.15, floorY + 10);
      ctx.lineTo(width * 0.85, floorY + 10);
      ctx.lineTo(width, floorY + 60);
      ctx.stroke();
      
      // Paint Area (Red)
      ctx.fillStyle = 'rgba(211, 47, 47, 0.85)';
      ctx.beginPath();
      ctx.moveTo(width * 0.35, floorY + 60);
      ctx.lineTo(width * 0.4, floorY + 10);
      ctx.lineTo(width * 0.6, floorY + 10);
      ctx.lineTo(width * 0.65, floorY + 60);
      ctx.fill();

      // Floor Reflection
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.fillRect(0, floorY, width, height - floorY);

      // Ball Shadow on Floor
      const shadowY = floorY + 40;
      if (ballRef.current && ballRef.current.position.y > shadowY - 200) {
          const heightFromGround = shadowY - BALL_RADIUS - ballRef.current.position.y;
          const shadowScale = Math.max(0, 1 - heightFromGround / 200);
          ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
          const sw = 90 * stateRef.current.ballScale * shadowScale;
          const sh = 24 * stateRef.current.ballScale * shadowScale;
          ctx.beginPath();
          ctx.ellipse(ballRef.current.position.x, shadowY, sw/2, sh/2, 0, 0, Math.PI * 2);
          ctx.fill();
      }

      // 3. Hoop Pole & Backboard Shadow
      const bbW = 200;
      const bbH = 140;
      const bbX = hoopX;
      const bbY = hoopY - 40;

      // Pole (Silver/Gray)
      const poleGrad = ctx.createLinearGradient(hoopX - 10, 0, hoopX + 10, 0);
      poleGrad.addColorStop(0, '#78909C');
      poleGrad.addColorStop(0.5, '#CFD8DC');
      poleGrad.addColorStop(1, '#546E7A');
      ctx.fillStyle = poleGrad;
      ctx.fillRect(hoopX - 10, bbY, 20, floorY - bbY + 20);
      
      // Pole Padding (Red)
      ctx.fillStyle = '#D32F2F';
      ctx.fillRect(hoopX - 15, floorY - 100, 30, 100);
      ctx.strokeStyle = '#B71C1C';
      ctx.lineWidth = 2;
      ctx.strokeRect(hoopX - 15, floorY - 100, 30, 100);

      // Backboard Shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.fillRect(bbX - bbW/2 + 10, bbY - bbH/2 + 10, bbW, bbH);

      // 4. Backboard (Smoked Glass)
      ctx.fillStyle = 'rgba(38, 50, 56, 0.85)'; // Dark blue-grey tinted glass
      ctx.fillRect(bbX - bbW/2, bbY - bbH/2, bbW, bbH);
      
      // Glass Reflection
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.moveTo(bbX - bbW/2, bbY - bbH/2);
      ctx.lineTo(bbX + bbW/2, bbY - bbH/2);
      ctx.lineTo(bbX + bbW/2 - 40, bbY + bbH/2);
      ctx.lineTo(bbX - bbW/2, bbY + bbH/2);
      ctx.fill();

      // Backboard Border
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 6;
      ctx.strokeRect(bbX - bbW/2, bbY - bbH/2, bbW, bbH);

      // Inner Square (White)
      const sqW = 70;
      const sqH = 50;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 4;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      ctx.strokeRect(hoopX - sqW/2, hoopY - sqH, sqW, sqH);

      // Helper to draw the ball
      const drawBall = () => {
          if (!ballRef.current) return;
          const pos = ballRef.current.position;
          const angle = ballRef.current.angle;
          let scale = stateRef.current.ballScale;

          ctx.save();
          ctx.translate(pos.x, pos.y);
          ctx.rotate(angle);
          ctx.scale(scale, scale);

          // Ball Base (Realistic Orange with Gradient)
          const ballGrad = ctx.createRadialGradient(-BALL_RADIUS*0.3, -BALL_RADIUS*0.3, BALL_RADIUS*0.1, 0, 0, BALL_RADIUS);
          ballGrad.addColorStop(0, '#FFB74D'); // Highlight
          ballGrad.addColorStop(0.4, '#F57C00'); // Base
          ballGrad.addColorStop(1, '#E65100'); // Shadow
          
          ctx.fillStyle = ballGrad;
          ctx.beginPath();
          ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
          ctx.fill();
          
          // Ball Lines (Curved, Realistic)
          ctx.strokeStyle = '#212121';
          ctx.lineWidth = 2.5;
          ctx.lineCap = 'round';
          
          // Cross lines
          ctx.beginPath();
          ctx.moveTo(0, -BALL_RADIUS);
          ctx.lineTo(0, BALL_RADIUS);
          ctx.moveTo(-BALL_RADIUS, 0);
          ctx.lineTo(BALL_RADIUS, 0);
          ctx.stroke();

          // Curved lines
          ctx.beginPath();
          ctx.ellipse(0, 0, BALL_RADIUS * 0.6, BALL_RADIUS, 0, 0, Math.PI * 2);
          ctx.stroke();

          ctx.restore();
      };

      // Determine drawing order based on Z-depth (scale) and position
      let drawBallBehindFrontRim = false;
      if (ballRef.current) {
          const ball = ballRef.current;
          const isFalling = ball.velocity.y > 0;
          const isBelowRimTop = ball.position.y > hoopY - 20;
          const isNearHoopX = Math.abs(ball.position.x - hoopX) < HOOP_WIDTH / 2 + 30;
          
          if (isFalling && isBelowRimTop && isNearHoopX) {
              drawBallBehindFrontRim = true;
          }
      }

      // Draw Ball IF it is behind the front rim
      if (drawBallBehindFrontRim) {
          drawBall();
      }

      // 5. Net (Realistic White)
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      
      const netTopW = HOOP_WIDTH;
      const netBotW = netTopW * 0.6;
      const netH = 65 + netStretch;
      const rows = 3; // 3 rows for better mesh
      const cols = 3; // 4 attachment points
      const sway = stateRef.current.netSway;
      const bulge = stateRef.current.netBulge;
      const ballX = ballRef.current?.position.x || 0;
      const ballY = ballRef.current?.position.y || 0;
      
      // Only move net if ball is falling through AND has scored
      const isBallInNet = stateRef.current.hasScored && ballY > hoopY && ballY < hoopY + netH + 40 && Math.abs(ballX - hoopX) < HOOP_WIDTH * 0.8;
      
      const netPoints: {x: number, y: number}[][] = [];
      for (let r = 0; r <= rows; r++) {
          const t = r / rows;
          // Taper the net more at the bottom
          const w = netTopW - (netTopW - netBotW) * Math.pow(t, 0.7);
          const y = hoopY + netH * t;
          const rowPts = [];
          for (let c = 0; c <= cols; c++) {
              const ct = c / cols;
              let x = hoopX - w/2 + sway * t + w * ct;
              let by = y;
              
              if (isBallInNet) {
                  const distY = Math.abs(ballY - y);
                  if (distY < 50) {
                      const bulgeAmt = (1 - distY/50) * 15 * stateRef.current.ballScale;
                      const dir = (ct - 0.5) * 2; 
                      x += dir * bulgeAmt;
                      by += bulgeAmt * 0.3;
                  }
              }
              
              if (bulge < 0) {
                  x += bulge * Math.sin(t * Math.PI) * (ct - 0.5) * 2;
              }
              
              rowPts.push({x, y: by});
          }
          netPoints.push(rowPts);
      }

      // Draw diamond pattern (V-shapes)
      ctx.beginPath();
      for (let r = 0; r < rows; r++) {
          for (let c = 0; c <= cols; c++) {
              // Left-to-right diagonal
              if (c < cols) {
                  ctx.moveTo(netPoints[r][c].x, netPoints[r][c].y);
                  ctx.lineTo(netPoints[r+1][c+1].x, netPoints[r+1][c+1].y);
              }
              // Right-to-left diagonal
              if (c > 0) {
                  ctx.moveTo(netPoints[r][c].x, netPoints[r][c].y);
                  ctx.lineTo(netPoints[r+1][c-1].x, netPoints[r+1][c-1].y);
              }
          }
      }
      
      // Add some vertical-ish ropes for more detail if needed, 
      // but the user said "look at the picture", and usually it's just this mesh.
      // The key is that the bottom is NOT connected.
      
      ctx.stroke();

      // 6. Front Rim (Realistic Orange/Red)
      ctx.beginPath();
      ctx.moveTo(hoopX - HOOP_WIDTH/2 - 4, hoopY);
      ctx.lineTo(hoopX + HOOP_WIDTH/2 + 4, hoopY);
      ctx.strokeStyle = '#E64A19';
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.stroke();
      
      // Rim Highlight
      ctx.beginPath();
      ctx.moveTo(hoopX - HOOP_WIDTH/2 - 2, hoopY - 2);
      ctx.lineTo(hoopX + HOOP_WIDTH/2 + 2, hoopY - 2);
      ctx.strokeStyle = '#FF8A65';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.stroke();

      // 7. Draw Ball IF it is in front of the front rim
      if (!drawBallBehindFrontRim) {
          drawBall();
      }
      
      ctx.restore(); // Restore pixel scale
  };

  const update = () => {
      if (stateRef.current.gameState === 'PLAYING' && containerRef.current && ballRef.current && hoopPartsRef.current) {
          const { width, height } = containerRef.current.getBoundingClientRect();
          const ball = ballRef.current;
          const parts = hoopPartsRef.current;
          
          // 1. Update Hoop Position based on score
          let targetAmpX = 0;
          let targetAmpY = 0;
          let speedX = 0;
          let speedY = 0;

          if (stateRef.current.score >= 10) {
              targetAmpX = width * 0.20;
              speedX = Math.min(0.15 + (stateRef.current.score - 10) * 0.015, 0.45);
          }
          if (stateRef.current.score >= 20) {
              targetAmpY = height * 0.08;
              speedY = Math.min(0.1 + (stateRef.current.score - 20) * 0.01, 0.35);
          }

          // Smoothly interpolate amplitude to prevent teleporting
          stateRef.current.hoopAmpX += (targetAmpX - stateRef.current.hoopAmpX) * 0.02;
          stateRef.current.hoopAmpY += (targetAmpY - stateRef.current.hoopAmpY) * 0.02;

          if (stateRef.current.hoopAmpX > 0.1) {
              stateRef.current.hoopPhaseX += speedX * 0.016;
          } else {
              stateRef.current.hoopPhaseX = 0;
          }

          if (stateRef.current.hoopAmpY > 0.1) {
              stateRef.current.hoopPhaseY += speedY * 0.016;
          } else {
              stateRef.current.hoopPhaseY = 0;
          }

          let targetX = stateRef.current.hoopBaseX + Math.sin(stateRef.current.hoopPhaseX) * stateRef.current.hoopAmpX;
          let targetY = stateRef.current.hoopBaseY + Math.sin(stateRef.current.hoopPhaseY) * stateRef.current.hoopAmpY;

          stateRef.current.hoopY = targetY;
          Matter.Body.setPosition(parts.rimL, { x: targetX - HOOP_WIDTH/2, y: targetY });
          Matter.Body.setPosition(parts.rimR, { x: targetX + HOOP_WIDTH/2, y: targetY });
          if (parts.rimBlocker) {
              Matter.Body.setPosition(parts.rimBlocker, { x: targetX, y: targetY });
          }
          // Reset velocity and positionPrev to prevent static bodies from imparting high elasticity to the ball
          Matter.Body.setVelocity(parts.rimL, { x: 0, y: 0 });
          Matter.Body.setVelocity(parts.rimR, { x: 0, y: 0 });
          if (parts.rimBlocker) {
              Matter.Body.setVelocity(parts.rimBlocker, { x: 0, y: 0 });
              parts.rimBlocker.positionPrev.x = parts.rimBlocker.position.x;
              parts.rimBlocker.positionPrev.y = parts.rimBlocker.position.y;
          }
          parts.rimL.positionPrev.x = parts.rimL.position.x;
          parts.rimL.positionPrev.y = parts.rimL.position.y;
          parts.rimR.positionPrev.x = parts.rimR.position.x;
          parts.rimR.positionPrev.y = parts.rimR.position.y;

          // 2. 3D Depth Illusion (Perspective Projection) & Scaling
          // Assuming player is 8m away, hoop is 10m away (2m difference).
          // Scale = Distance_Start / Distance_Current = 8 / (8 + 2 * progress)
          const startY = height - 110 - BALL_RADIUS;
          const currentYForScale = ball.velocity.y < 0 ? ball.position.y : stateRef.current.highestY;
          const progress = (startY - currentYForScale) / (startY - targetY);
          
          // Perspective formula: 1 / (1 + 0.25 * progress)
          // At progress = 0 (start), scale = 1.0
          // At progress = 1.0 (hoop), scale = 1 / 1.25 = 0.8
          let targetScale = 1.0 / (1.0 + 0.25 * progress);
          targetScale = Math.max(0.6, Math.min(1.0, targetScale)); // Cap just in case
          
          if (Math.abs(targetScale - stateRef.current.ballScale) > 0.001) {
              const factor = targetScale / stateRef.current.ballScale;
              Matter.Body.scale(ball, factor, factor);
              stateRef.current.ballScale = targetScale;
          }

          // Track highest Y
          if (!stateRef.current.ballCanShoot && !stateRef.current.isRollingBack) {
              stateRef.current.highestY = Math.min(stateRef.current.highestY, ball.position.y);
          }

          let mask = CATEGORY_WALL | CATEGORY_SENSOR;
          let isAbove = false;

          // Realistic Rim Physics: 
          // Ball should collide with rim if it's falling OR if it's physically above the rim level.
          // If it's going up and hits the rim from below, it should also collide (bounce back).
          const ballRadiusScaled = BALL_RADIUS * stateRef.current.ballScale;
          
          if (ball.position.y < targetY + ballRadiusScaled) {
              mask |= CATEGORY_HOOP;
              isAbove = ball.position.y < targetY;
          } else {
              isAbove = false;
          }

          ball.collisionFilter.mask = mask;
          stateRef.current.isAboveHoop = isAbove;

          // Enable rimBlocker if the ball is falling but didn't clear the rim
          if (parts.rimBlocker) {
              if (ball.velocity.y > 0 && stateRef.current.highestY > targetY - ballRadiusScaled) {
                  parts.rimBlocker.collisionFilter.mask = CATEGORY_BALL;
              } else {
                  parts.rimBlocker.collisionFilter.mask = 0;
              }
          }

          // Scoring logic
          if (ball.velocity.y > 0 && ball.position.y > targetY && ball.position.y < targetY + 40) {
              // Ball must fully clear the rim to score
              if (!stateRef.current.hasScored && stateRef.current.highestY < targetY - ballRadiusScaled) {
                  const dx = Math.abs(ball.position.x - targetX);
                  // Forgiving dx for high hit rate
                  const tolerance = stateRef.current.hoopAmpX > 10 ? 45 : 35;
                  if (dx < HOOP_WIDTH/2 + tolerance) {
                      scorePoint();
                  }
              }
          }

          // Net entry physics (Dynamic feel)
          if (ball.velocity.y > 0 && ball.position.y > targetY - 20 && ball.position.y < targetY + 100 && Math.abs(ball.position.x - targetX) < HOOP_WIDTH/2 + 40) {
              // 1. Simulate net friction by slowing the ball down
              Matter.Body.setVelocity(ball, {
                  x: ball.velocity.x * 0.8,
                  y: ball.velocity.y * 0.8
              });
              // 2. Pull the ball slightly towards the center of the net (Stronger magnet effect)
              const pullStrength = stateRef.current.hoopAmpX > 10 ? 0.3 : 0.2;
              const pullX = (targetX - ball.position.x) * pullStrength;
              Matter.Body.applyForce(ball, ball.position, { x: pullX * 0.001, y: 0 });
          }

          // 3. Net Animation Physics
          let targetStretch = 0;
          let targetBulge = 0;
          
          // Only trigger net stretch if the ENTIRE ball has passed the rim (y - radius > targetY)
          if (ball.velocity.y > 0 && (ball.position.y - BALL_RADIUS * stateRef.current.ballScale) > targetY && ball.position.y < targetY + 150 && 
              Math.abs(ball.position.x - targetX) < HOOP_WIDTH / 2 + 10) {
              // Ball is falling inside the net
              targetStretch = (ball.position.y - targetY) * 0.8; 
              // Localized bulge is handled in the drawing code now
              targetBulge = 0;
          } else if (stateRef.current.hasScored && ball.position.y >= targetY + 100 && ball.position.y < targetY + 200) {
              // Ball just passed through, give it a final tug
              targetStretch = 40;
              stateRef.current.netSwayVelocity = ball.velocity.x * 0.25; // Trigger sway
              targetBulge = 0; // No inward ripple to prevent springy look
          }

          const stretchForce = (targetStretch - stateRef.current.netStretch) * 0.1; // Less springy
          stateRef.current.netVelocity += stretchForce;
          stateRef.current.netStretch += stateRef.current.netVelocity;
          stateRef.current.netVelocity *= 0.6; // High damping
          
          const swayForce = -stateRef.current.netSway * 0.05;
          stateRef.current.netSwayVelocity += swayForce;
          stateRef.current.netSway += stateRef.current.netSwayVelocity;
          stateRef.current.netSwayVelocity *= 0.85; // Sway damping
          
          const bulgeForce = (targetBulge - stateRef.current.netBulge) * 0.1;
          stateRef.current.netBulgeVelocity += bulgeForce;
          stateRef.current.netBulge += stateRef.current.netBulgeVelocity;
          stateRef.current.netBulgeVelocity *= 0.6; // High damping

          // Trail
          if (stateRef.current.gameState === 'PLAYING' && !stateRef.current.isRollingBack && !stateRef.current.ballCanShoot) {
              stateRef.current.ballTrail.push({ x: ball.position.x, y: ball.position.y, scale: stateRef.current.ballScale });
              if (stateRef.current.ballTrail.length > 8) {
                  stateRef.current.ballTrail.shift();
              }
          } else {
              stateRef.current.ballTrail = [];
          }

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
              const endY = height - 110 - BALL_RADIUS; // Starting Y position
              
              // Add a parabolic arc to the return trajectory
              const arcHeight = 200;
              const currentY = rollStartY + (endY - rollStartY) * easeOut - Math.sin(easeOut * Math.PI) * arcHeight;
              
              Matter.Body.setPosition(ball, {
                  x: startX + (endX - startX) * easeOut,
                  y: currentY
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
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
          
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
                      Matter.Body.setVelocity(parts.rimL, { x: 0, y: 0 });
                      Matter.Body.setVelocity(parts.rimR, { x: 0, y: 0 });
                  }
              }
              
              if (stateRef.current.ballCanShoot && ballRef.current) {
                  Matter.Body.setPosition(ballRef.current, { x: width / 2, y: height - 110 - BALL_RADIUS });
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
    <div className="relative w-full h-screen bg-[#111] flex justify-center overflow-hidden touch-none select-none" style={{ fontFamily: 'Impact, "Arial Black", sans-serif' }}>
      <div 
        ref={containerRef}
        className="relative w-full max-w-md h-full bg-[#E8ECEF] cursor-pointer shadow-2xl touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* Top UI */}
        <div className="absolute top-6 left-6 z-20">
            <div className="w-10 h-10 bg-white/90 flex flex-col items-center justify-center gap-1 cursor-pointer hover:bg-gray-200 transition-colors border-2 border-black shadow-[4px_4px_0px_rgba(0,0,0,1)] rounded-sm">
                <div className="w-5 h-1 bg-black"></div>
                <div className="w-5 h-1 bg-black"></div>
                <div className="w-5 h-1 bg-black"></div>
            </div>
        </div>
        
        <div className="absolute top-6 right-6 z-20 flex flex-col items-end gap-2">
            {/* Best Score Badge */}
            <div className="flex items-center bg-white/90 px-3 py-2 border-2 border-black shadow-[4px_4px_0px_rgba(0,0,0,1)] rounded-sm">
                <span className="text-black text-[10px] uppercase tracking-wider mr-2 font-bold">BEST</span>
                <span className="text-[#D32F2F] text-lg font-bold">{bestScore}</span>
            </div>
            
            {/* Total Goals Badge (Now Session Score) */}
            <div className="flex items-center bg-white/90 pr-4 pl-2 py-2 border-2 border-black shadow-[4px_4px_0px_rgba(0,0,0,1)] rounded-sm">
                <div className="w-6 h-6 bg-[#F57C00] rounded-full flex items-center justify-center border-2 border-black mr-2 relative overflow-hidden">
                    {/* Basketball Icon */}
                    <div className="absolute inset-0 border-b-2 border-black top-1/2 -translate-y-1/2"></div>
                    <div className="absolute inset-0 border-r-2 border-black left-1/2 -translate-x-1/2"></div>
                    <div className="absolute inset-0 border-2 border-black rounded-full scale-75 opacity-50"></div>
                    <div className="absolute inset-0 border-2 border-black rounded-full scale-110 -translate-x-1/2 -translate-y-1/2 left-0 top-0 opacity-30"></div>
                    <div className="absolute inset-0 border-2 border-black rounded-full scale-110 translate-x-1/2 translate-y-1/2 right-0 bottom-0 opacity-30"></div>
                </div>
                <span className="text-black text-lg font-bold">{score}</span>
            </div>
        </div>

        <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-0" />

        <AnimatePresence>
            {floatingTexts.map(ft => (
                <motion.div
                    key={ft.id}
                    initial={{ opacity: 0, y: ft.y, x: ft.x, scale: 0.5 }}
                    animate={{ opacity: 1, y: ft.y - 120, x: ft.x, scale: 1.5 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 1, ease: "easeOut" }}
                    className="absolute text-3xl z-40 pointer-events-none font-bold italic"
                    style={{ 
                        left: 0, 
                        top: 0, 
                        marginLeft: '-1rem',
                        color: '#D32F2F',
                        textShadow: '2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 4px 4px 0 rgba(0,0,0,0.5)',
                        transform: 'skewX(-10deg)'
                    }}
                >
                    SWISH!
                </motion.div>
            ))}
        </AnimatePresence>

        {/* Overlays */}
        <AnimatePresence>
           {gameState === 'START' && (
               <motion.div 
                   initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                   className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/60 pointer-events-none backdrop-blur-sm"
               >
                  <div className="text-white text-6xl mb-8 text-center leading-tight font-bold italic skew-x-[-5deg]" style={{ textShadow: '4px 4px 0 #000' }}>
                      SLAM<br/><span className="text-[#D32F2F]">HOOPS</span>
                  </div>
                  <div className="text-white text-sm mb-12 text-center font-bold tracking-widest animate-pulse" style={{ textShadow: '2px 2px 0 #000' }}>
                      SWIPE UP TO SHOOT
                  </div>
                  <div className="w-12 h-20 border-4 border-white flex justify-center p-2 opacity-80">
                      <motion.div 
                          animate={{ y: [30, 0, 30] }} 
                          transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
                          className="w-4 h-4 bg-[#D32F2F]"
                      />
                  </div>
               </motion.div>
           )}
           {gameState === 'GAME_OVER' && (
               <motion.div 
                   initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                   className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/60 pointer-events-none backdrop-blur-sm"
               >
                  <div className="text-white text-xl mb-2 font-bold tracking-widest" style={{ textShadow: '2px 2px 0 #000' }}>SCORE</div>
                  <div className="text-7xl text-[#D32F2F] mb-12 font-bold" style={{ textShadow: '4px 4px 0 #000' }}>{score}</div>
                  <div className="bg-[#D32F2F] text-white px-8 py-4 border-4 border-black text-xl font-bold italic skew-x-[-5deg] shadow-[6px_6px_0_#000] animate-pulse">
                     TAP TO RESTART
                  </div>
               </motion.div>
           )}
        </AnimatePresence>
      </div>
    </div>
  );
}
