
// import React, { useState } from 'react';
// import { userService } from '../services/userService';
// import { User } from '../types';

// interface AuthProps {
//   onLogin: (user: User) => void;
// }


// const Auth: React.FC<AuthProps> = ({ onLogin }) => {
//   const [isLogin, setIsLogin] = useState(true);
//   const [email, setEmail] = useState('');
//   const [password, setPassword] = useState('');
//   const [name, setName] = useState('');
//   const [phone, setPhone] = useState('');
//   const [error, setError] = useState('');

//   const handleSubmit = (e: React.FormEvent) => {
//     e.preventDefault();
//     setError('');
    
//     try {
//       if (isLogin) {
//         const user = userService.login(email, password);
//         onLogin(user);
//       } else {
//         const user = userService.register(email, password, name, phone);
//         onLogin(user);
//       }
//     } catch (err: any) {
//       setError(err.message);
//     }
//   };

//   const handleGoogleLogin = () => {
//     // Simulation
//     alert("Google Login Simulation: Redirecting to OAuth provider...");
//     setTimeout(() => {
//       try {
//         // Simulate successful Google login with a new or existing user
//         // For demo, we'll just log in as user1 if email matches, or create a new one
//         const user = userService.login('player@demo.com', 'player123'); 
//         onLogin(user);
//       } catch (e) {
//         // Fallback if user1 doesn't exist or password changed
//         alert("Google Login Simulation: User not found in demo data.");
//       }
//     }, 1000);
//   };


//   return (
//     <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-6 font-sans">
//       <div className="max-w-md w-full bg-white rounded-lg border-2 border-neutral-200 p-8 shadow-xl">
//         <div className="text-center mb-8">
//           <div className="w-16 h-16 bg-neutral-900 flex items-center justify-center text-white mx-auto mb-4 transform -skew-x-12">
//             <i className="fas fa-running text-3xl"></i>
//           </div>
//           <h1 className="text-3xl font-black text-neutral-900 uppercase italic tracking-tighter">UniSport</h1>
//           <p className="text-neutral-500 font-bold uppercase tracking-widest text-xs mt-2">Elite Sports Management</p>
//         </div>

//         {/* Auth Tabs */}
//         <div className="flex border-b-2 border-neutral-100 mb-8">
//           <button 
//             className={`flex-1 py-3 text-xs font-black uppercase tracking-widest transition-colors ${isLogin ? 'text-orange-600 border-b-2 border-orange-600' : 'text-neutral-400 hover:text-neutral-600'}`}
//             onClick={() => { setIsLogin(true); setError(''); }}
//           >
//             Log In
//           </button>
//           <button 
//             className={`flex-1 py-3 text-xs font-black uppercase tracking-widest transition-colors ${!isLogin ? 'text-orange-600 border-b-2 border-orange-600' : 'text-neutral-400 hover:text-neutral-600'}`}
//             onClick={() => { setIsLogin(false); setError(''); }}
//           >
//             Register
//           </button>
//         </div>

//         {error && (
//           <div className="mb-6 p-3 bg-red-50 text-red-600 text-xs font-bold uppercase tracking-wide border border-red-200 flex items-center gap-2">
//             <i className="fas fa-exclamation-circle"></i>
//             {error}
//           </div>
//         )}

//         <form onSubmit={handleSubmit} className="space-y-4">
//           {!isLogin && (
//             <>
//               <div className="animate-in slide-in-from-top-2 duration-200 fade-in">
//                 <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">Full Name</label>
//                 <input 
//                   type="text" 
//                   required
//                   className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
//                   value={name}
//                   onChange={(e) => setName(e.target.value)}
//                   placeholder="JOHN DOE"
//                 />
//               </div>
//               <div className="animate-in slide-in-from-top-2 duration-200 fade-in delay-75">
//                 <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">Phone Number</label>
//                 <input 
//                   type="tel" 
//                   required
//                   className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
//                   value={phone}
//                   onChange={(e) => setPhone(e.target.value)}
//                   placeholder="+91 98765 43210"
//                 />
//               </div>
//             </>
//           )}

//           <div className={!isLogin ? "animate-in slide-in-from-top-2 duration-200 fade-in delay-100" : ""}>
//             <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">Email Address</label>
//             <input 
//               type="email" 
//               required
//               className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
//               value={email}
//               onChange={(e) => setEmail(e.target.value)}
//               placeholder="PLAYER@EXAMPLE.COM"
//             />
//           </div>
          
//           <div className={!isLogin ? "animate-in slide-in-from-top-2 duration-200 fade-in delay-150" : ""}>
//             <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">Password</label>
//             <input 
//               type="password" 
//               required
//               className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
//               value={password}
//               onChange={(e) => setPassword(e.target.value)}
//               placeholder="••••••••"
//             />
//           </div>

//           <button 
//             type="submit"
//             className="w-full bg-neutral-900 text-white font-black uppercase tracking-widest py-4 rounded-lg hover:bg-orange-600 transition-all mt-6 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
//           >
//             {isLogin ? 'Sign In' : 'Create Account'}
//           </button>
//         </form>

//         <div className="mt-6 flex items-center gap-4">
//           <div className="h-px bg-neutral-200 flex-1"></div>
//           <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">OR</span>
//           <div className="h-px bg-neutral-200 flex-1"></div>
//         </div>

//         <div className="mt-6">
//           <button 
//             type="button"
//             onClick={handleGoogleLogin}
//             className="w-full bg-white border-2 border-neutral-200 text-neutral-900 font-bold uppercase tracking-wider py-3 rounded-lg hover:bg-neutral-50 transition-all flex items-center justify-center gap-2 text-xs group"
//           >
//             <i className="fab fa-google text-red-500 group-hover:scale-110 transition-transform"></i>
//             Sign in with Google
//           </button>
//         </div>

//         <div className="mt-8 pt-6 border-t-2 border-neutral-100 text-[10px] text-neutral-400 text-center font-mono uppercase">
//           <p className="font-bold mb-2">Demo Access:</p>
//           <p>Admin: admin@unisport.com / admin123</p>
//           <p>Owner: owner@padel.com / owner123</p>
//           <p>User: player@demo.com / player123</p>
//         </div>
//       </div>
//     </div>
//   );
// };

// export default Auth;

import React, { useState } from 'react';
import { userService } from '../services/userService';
import { authOtpService } from '../services/authOtpService';
import { User } from '../types';

interface AuthProps {
  onLogin: (user: User) => void;
}

const Auth: React.FC<AuthProps> = ({ onLogin }) => {
  const [isLogin, setIsLogin] = useState(true);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpChannel, setOtpChannel] = useState<'email' | 'phone'>('email');

  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [demoOtpMessage, setDemoOtpMessage] = useState('');
  const [sendingOtp, setSendingOtp] = useState(false);

  const isValidPhoneNumber = (value: string) => {
    const cleaned = value.replace(/\D/g, '');
    return cleaned.length >= 10 && cleaned.length <= 12;
  };

  const resetRegisterVerification = () => {
    setOtp('');
    setOtpSent(false);
    setOtpVerified(false);
    setDemoOtpMessage('');
    setInfo('');
    setConfirmPassword('');
    authOtpService.clearOtp();
  };

  const switchMode = (loginMode: boolean) => {
    setIsLogin(loginMode);
    setError('');
    resetRegisterVerification();
  };

  const handleSendOtp = () => {
    setError('');
    setInfo('');
    setOtpVerified(false);

    if (!name.trim()) {
      setError('Please enter your full name first.');
      return;
    }

    if (!phone.trim()) {
      setError('Please enter your phone number first.');
      return;
    }

    if (!isValidPhoneNumber(phone)) {
      setError('Please enter a valid phone number.');
      return;
    }

    if (!email.trim()) {
      setError('Please enter your email address first.');
      return;
    }

    const identifier = otpChannel === 'email' ? email.trim() : phone.trim();

    setSendingOtp(true);

    setTimeout(() => {
      const generatedOtp = authOtpService.sendOtp(identifier, otpChannel);
      setOtpSent(true);
      setDemoOtpMessage(
        `Demo ${otpChannel.toUpperCase()} OTP sent to ${identifier}: ${generatedOtp}`
      );
      setInfo(`OTP sent via ${otpChannel}.`);
      setSendingOtp(false);
    }, 500);
  };

  const handleVerifyOtp = () => {
    setError('');
    setInfo('');

    try {
      if (!otpSent) {
        throw new Error('Please send OTP first.');
      }

      if (!otp.trim()) {
        throw new Error('Please enter the OTP.');
      }

      const identifier = otpChannel === 'email' ? email.trim() : phone.trim();

      authOtpService.verifyOtp(identifier, otpChannel, otp.trim());

      setOtpVerified(true);
      setInfo('OTP verified successfully.');
    } catch (err: any) {
      setOtpVerified(false);
      setError(err.message);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');

    try {
      if (isLogin) {
        const user = userService.login(email, password);
        onLogin(user);
        return;
      }

      if (!otpSent) {
        throw new Error('Please send OTP before creating account.');
      }

      if (!otpVerified) {
        throw new Error('Please verify OTP before creating account.');
      }

      if (!isValidPhoneNumber(phone)) {
        throw new Error('Please enter a valid phone number.');
      }

      if (password !== confirmPassword) {
        throw new Error('Passwords do not match.');
      }

      const user = userService.register(email, password, name, phone);
      resetRegisterVerification();
      onLogin(user);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleGoogleLogin = () => {
    alert('Google Login Simulation: Redirecting to OAuth provider...');

    setTimeout(() => {
      try {
        const user = userService.login('player@demo.com', 'player123');
        onLogin(user);
      } catch {
        alert('Google Login Simulation: User not found in demo data.');
      }
    }, 1000);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-6 font-sans">
      <div className="max-w-md w-full bg-white rounded-lg border-2 border-neutral-200 p-8 shadow-xl">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-neutral-900 flex items-center justify-center text-white mx-auto mb-4 transform -skew-x-12">
            <i className="fas fa-running text-3xl"></i>
          </div>
          <h1 className="text-3xl font-black text-neutral-900 uppercase italic tracking-tighter">
            UniSport
          </h1>
          <p className="text-neutral-500 font-bold uppercase tracking-widest text-xs mt-2">
            Elite Sports Management
          </p>
        </div>

        <div className="flex border-b-2 border-neutral-100 mb-8">
          <button
            className={`flex-1 py-3 text-xs font-black uppercase tracking-widest transition-colors ${
              isLogin
                ? 'text-orange-600 border-b-2 border-orange-600'
                : 'text-neutral-400 hover:text-neutral-600'
            }`}
            onClick={() => switchMode(true)}
          >
            Log In
          </button>
          <button
            className={`flex-1 py-3 text-xs font-black uppercase tracking-widest transition-colors ${
              !isLogin
                ? 'text-orange-600 border-b-2 border-orange-600'
                : 'text-neutral-400 hover:text-neutral-600'
            }`}
            onClick={() => switchMode(false)}
          >
            Register
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-600 text-xs font-bold uppercase tracking-wide border border-red-200 flex items-center gap-2">
            <i className="fas fa-exclamation-circle"></i>
            {error}
          </div>
        )}

        {info && (
          <div className="mb-4 p-3 bg-emerald-50 text-emerald-700 text-xs font-bold uppercase tracking-wide border border-emerald-200 flex items-center gap-2">
            <i className="fas fa-circle-check"></i>
            {info}
          </div>
        )}

        {!isLogin && demoOtpMessage && (
          <div className="mb-4 p-3 bg-orange-50 text-orange-700 text-xs font-bold border border-orange-200">
            {demoOtpMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <>
              <div>
                <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="JOHN DOE"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
                  Phone Number
                </label>
                <input
                  type="tel"
                  required
                  className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
              Email Address
            </label>
            <input
              type="email"
              required
              className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="PLAYER@EXAMPLE.COM"
            />
          </div>

          <div>
            <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
              Password
            </label>
            <input
              type="password"
              required
              className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {!isLogin && (
            <div>
              <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
                Confirm Password
              </label>
              <input
                type="password"
                required
                className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          )}

          {!isLogin && (
            <>
              <div className="pt-2">
                <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-2">
                  Verification Channel
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setOtpChannel('email');
                      resetRegisterVerification();
                    }}
                    className={`py-3 rounded-lg text-xs font-black uppercase tracking-widest border-2 transition-colors ${
                      otpChannel === 'email'
                        ? 'bg-neutral-900 text-white border-neutral-900'
                        : 'bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400'
                    }`}
                  >
                    Email OTP
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setOtpChannel('phone');
                      resetRegisterVerification();
                    }}
                    className={`py-3 rounded-lg text-xs font-black uppercase tracking-widest border-2 transition-colors ${
                      otpChannel === 'phone'
                        ? 'bg-neutral-900 text-white border-neutral-900'
                        : 'bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400'
                    }`}
                  >
                    SMS OTP
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
                <div>
                  <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
                    Enter OTP
                  </label>
                  <input
                    type="text"
                    maxLength={6}
                    className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors tracking-[0.3em]"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                    placeholder="123456"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleSendOtp}
                  disabled={sendingOtp}
                  className={`px-4 py-3 rounded-lg text-xs font-black uppercase tracking-widest transition-colors ${
                    sendingOtp
                      ? 'bg-neutral-300 text-neutral-500 cursor-not-allowed'
                      : 'bg-neutral-900 text-white hover:bg-orange-600'
                  }`}
                >
                  {sendingOtp ? 'Sending...' : otpSent ? 'Resend OTP' : 'Send OTP'}
                </button>
              </div>

              <button
                type="button"
                onClick={handleVerifyOtp}
                className={`w-full py-3 rounded-lg text-xs font-black uppercase tracking-widest transition-colors ${
                  otpVerified
                    ? 'bg-emerald-600 text-white'
                    : 'bg-white border-2 border-neutral-200 text-neutral-900 hover:border-orange-500'
                }`}
              >
                {otpVerified ? 'OTP Verified' : 'Verify OTP'}
              </button>

              <div className="text-[10px] text-neutral-400 font-bold uppercase tracking-wide">
                Demo mode: OTP is simulated for both email and phone verification.
              </div>
            </>
          )}

          <button
            type="submit"
            className="w-full bg-neutral-900 text-white font-black uppercase tracking-widest py-4 rounded-lg hover:bg-orange-600 transition-all mt-6 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
          >
            {isLogin ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div className="mt-6 flex items-center gap-4">
          <div className="h-px bg-neutral-200 flex-1"></div>
          <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">
            OR
          </span>
          <div className="h-px bg-neutral-200 flex-1"></div>
        </div>

        <div className="mt-6">
          <button
            type="button"
            onClick={handleGoogleLogin}
            className="w-full bg-white border-2 border-neutral-200 text-neutral-900 font-bold uppercase tracking-wider py-3 rounded-lg hover:bg-neutral-50 transition-all flex items-center justify-center gap-2 text-xs group"
          >
            <i className="fab fa-google text-red-500 group-hover:scale-110 transition-transform"></i>
            Sign in with Google
          </button>
        </div>

        <div className="mt-8 pt-6 border-t-2 border-neutral-100 text-[10px] text-neutral-400 text-center font-mono uppercase">
          <p className="font-bold mb-2">Demo Access:</p>
          <p>Admin: admin@unisport.com / admin123</p>
          <p>Owner: owner@padel.com / owner123</p>
          <p>User: player@demo.com / player123</p>
        </div>
      </div>
    </div>
  );
};

export default Auth;