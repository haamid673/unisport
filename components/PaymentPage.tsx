import React, { useState } from "react";
import { User, SelectedAmenity } from "../types";
import { createBookingTransactional } from "../services/bookingService";
import { paymentService } from "../services/paymentService";

interface PaymentPageProps {
  user: User;
  data: {
    slotId: string;
    facilityId: string | undefined;
    date: string;
    slotPrice: number;
    price: number;
    selectedAmenities?: SelectedAmenity[];
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

  const amenitiesTotal = (data.selectedAmenities || []).reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  const slotPrice = data.slotPrice;
  const totalAmount = data.price;

  const handlePayment = () => {
    setLoading(true);

    setTimeout(() => {
      const fakeTransactionId =
        "TXN_" +
        Math.random().toString(36).substring(2, 8).toUpperCase() +
        "_" +
        Date.now().toString().slice(-4);

      createBookingTransactional(
        data.slotId,
        user.id,
        data.date,
        data.selectedAmenities || [],
        totalAmount
      );

      paymentService.savePayment({
        id: Date.now().toString(),
        userId: user.id,
        slotId: data.slotId,
        amount: totalAmount,
        status: "success",
        transactionId: fakeTransactionId,
        date: new Date().toISOString(),
      });

      console.log(`
📧 EMAIL SENT TO: ${user.email}
Subject: UniSport Booking Confirmation

Hi ${user.name},

Your booking is confirmed 🎉

Transaction ID: ${fakeTransactionId}
Amount Paid: ₹${totalAmount}
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

        <div className="bg-neutral-100 rounded-lg p-5 space-y-4 text-sm">
          <div className="flex justify-between items-center">
            <span className="font-bold text-neutral-500 uppercase">Date</span>
            <span className="text-neutral-900">{data.date}</span>
          </div>

          <div className="border-t border-neutral-200 pt-4">
            <div className="flex justify-between items-center">
              <span className="font-bold text-neutral-500 uppercase">Slot Price</span>
              <span className="text-neutral-900 font-semibold">₹{slotPrice}</span>
            </div>
          </div>

          {data.selectedAmenities && data.selectedAmenities.length > 0 && (
            <div className="border-t border-neutral-200 pt-4">
              <p className="font-bold text-neutral-500 uppercase mb-3">Amenities</p>

              <div className="space-y-2">
                {data.selectedAmenities.map(item => (
                  <div key={item.amenityId} className="flex justify-between items-center">
                    <span className="text-neutral-900">
                      {item.name} × {item.quantity}
                    </span>
                    <span className="text-neutral-900 font-semibold">
                      ₹{item.price * item.quantity}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-neutral-300 pt-4 flex justify-between items-center">
            <span className="font-bold text-neutral-500 uppercase">Total</span>
            <span className="font-black text-2xl text-neutral-900">
              ₹{totalAmount}
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
          {loading ? "Processing..." : `Pay ₹${totalAmount}`}
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