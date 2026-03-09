import React, { useState } from "react";
import { User } from "../types";
import { createBookingTransactional } from "../services/bookingService";
import { paymentService } from "../services/paymentService";

interface PaymentPageProps {
  user: User;
  data: {
    slotId: string;
    facilityId: string | undefined;
    date: string;
    price: number;
  };
  onSuccess: () => void;
  onCancel: () => void;
  onSuccessMessage?: (msg: string) => void;
}

const PaymentPage: React.FC<PaymentPageProps> = ({
  user,
  data,
  onSuccess,
  onCancel,
  onSuccessMessage
}) => {
  const [loading, setLoading] = useState(false);

  const handlePayment = () => {
    setLoading(true);

    setTimeout(() => {
      const fakeTransactionId =
        "TXN_" +
        Math.random().toString(36).substring(2, 8).toUpperCase() +
        "_" +
        Date.now().toString().slice(-4);

      // Create booking
      createBookingTransactional(
        data.slotId,
        user.id,
        data.date
      );

      // Store payment
      paymentService.savePayment({
        id: Date.now().toString(),
        userId: user.id,
        slotId: data.slotId,
        amount: data.price,
        status: "success",
        transactionId: fakeTransactionId,
        date: new Date().toISOString(),
      });

      // Fake email simulation
      console.log(`
📧 EMAIL SENT TO: ${user.email}
Subject: UniSport Booking Confirmation

Hi ${user.name},

Your booking is confirmed 🎉

Transaction ID: ${fakeTransactionId}
Amount Paid: ₹${data.price}
Date: ${data.date}

Thank you for choosing UniSport.
`);

      if (onSuccessMessage) {
        onSuccessMessage("Payment Successful 🎉 Booking Confirmed");
      }

      setLoading(false);
      onSuccess();
    }, 2000);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 px-4">
      <div className="bg-white w-full max-w-md rounded-xl shadow-xl border border-neutral-200 p-8 space-y-6">

        <h2 className="text-2xl font-black uppercase tracking-tight text-neutral-900">
          Complete Payment
        </h2>

        <div className="bg-neutral-100 rounded-lg p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="font-bold text-neutral-500 uppercase">Date</span>
            <span>{data.date}</span>
          </div>

          <div className="flex justify-between">
            <span className="font-bold text-neutral-500 uppercase">Amount</span>
            <span className="font-black text-lg text-neutral-900">
              ₹{data.price}
            </span>
          </div>
        </div>

        <button
          onClick={handlePayment}
          disabled={loading}
          className={`w-full py-3 rounded-md font-black uppercase tracking-widest transition-all ${
            loading
              ? "bg-neutral-400 text-white cursor-not-allowed"
              : "bg-black text-white hover:bg-orange-600"
          }`}
        >
          {loading ? "Processing..." : "Pay Now"}
        </button>

        <button
          onClick={onCancel}
          className="w-full text-xs text-neutral-500 uppercase tracking-widest hover:text-neutral-900 transition"
        >
          Cancel
        </button>

        {loading && (
          <p className="text-xs text-neutral-400 text-center uppercase tracking-widest">
            Verifying with bank...
          </p>
        )}
      </div>
    </div>
  );
};

export default PaymentPage;