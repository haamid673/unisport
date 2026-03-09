import { storageService, STORAGE_KEYS } from "./storageService";

export interface Payment {
  id: string;
  userId: string;
  slotId: string;
  amount: number;
  status: "success" | "failed";
  transactionId: string;
  date: string;
}

const PAYMENT_KEY = "unisport_payments";

export const paymentService = {
  savePayment: (payment: Payment) => {
    const payments = storageService.get<Payment[]>(PAYMENT_KEY, []);
    payments.push(payment);
    storageService.set(PAYMENT_KEY, payments);
  },

  getPaymentsByUser: (userId: string) => {
    const payments = storageService.get<Payment[]>(PAYMENT_KEY, []);
    return payments.filter(p => p.userId === userId);
  }
};